/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 *
 * BC SO Sourcing User Event (hardened)
 *
 * Changes from prior version:
 *   - Close/cancel detection: now triggers on status transition into ANY
 *     closed-ish status on CREATE/EDIT/XEDIT, not just cancel/close types
 *   - Copy detection: handles both record copy (T.COPY) and line copy
 *     (lines with processed=true / linked_to populated but no database line ID
 *     = newly inserted from a Copy Line action — wipe them)
 *   - Stronger linkage-clear guard: validates that "unlocking" a line in the
 *     same save requires clearing BOTH linked_to AND processed
 */
define([
    'N/record',
    'N/search',
    'N/runtime',
    'N/log',
    'N/ui/serverWidget',
    'N/url'
], function (record, search, runtime, log, serverWidget, url) {

    // ---------- Constants ----------

    var SOURCING_METHOD_TO = '3';
    var SUBLIST = 'item';

    var FIELD = {
        METHOD:       'custcol_bc_sourcing_method',
        FROM_LOC:     'custcol_bc_source_from_location',
        QTY_TRANSFER: 'custcol_bc_qty_to_transfer',
        LINKED_TO:    'custcol_bc_linked_to',
        PROCESSED:    'custcol_bc_sourcing_processed',
        ERROR:        'custcol_bc_sourcing_error'
    };

    var PICKER_SCRIPT_ID = 'customscript_bc_sl_inventory_picker';
    var PICKER_DEPLOY_ID = 'customdeploy_bc_sl_inventory_picker';
    var PARAM_TO_ORDER_STATUS = 'custscript_bc_to_orderstatus';
    var PARAM_TO_SOURCE_SO_FIELD = 'custscript_bc_to_source_so_field';
    var DEFAULT_TO_ORDER_STATUS = 'A';
    var DEFAULT_TO_SOURCE_SO_FIELD = 'custbody_bc_source_so';
    var INVBAL_AVAILABLE_FIELD = 'available';

    var ALLOWED_ITEM_TYPES = { 'InvtPart': true, 'Assembly': true };

    // Active TO statuses (block SO close/cancel when any line has one)
    var ACTIVE_TO_STATUSES = {
        'TrnfrOrd:A': true,
        'TrnfrOrd:B': true,
        'TrnfrOrd:D': true,
        'TrnfrOrd:E': true,
        'TrnfrOrd:F': true,
        'TrnfrOrd:G': true,
        'pendingApproval': true,
        'pendingFulfillment': true,
        'partiallyFulfilled': true,
        'pendingReceiptPartFulfilled': true,
        'pendingReceipt': true,
        'received': true,
        'Pending Approval': true,
        'Pending Fulfillment': true,
        'Partially Fulfilled': true,
        'Pending Receipt/Partially Fulfilled': true,
        'Pending Receipt': true,
        'Received': true
    };

    var CANCELLED_TO_STATUSES = {
        'TrnfrOrd:H': true,
        'H': true,
        'cancelled': true,
        'cancelledOrder': true,
        'Cancelled': true
    };

    // SO "closed-ish" statuses — blocks transition into these when active TOs exist
    var SO_CLOSED_STATUSES = {
        'F': true, 'closedOrder': true,
        'H': true, 'cancelled': true,
        'closed': true,
        'SalesOrd:F': true, 'SalesOrd:H': true
    };

    var SO_PENDING_FULFILLMENT_STATUSES = {
        'B': true,
        'SalesOrd:B': true,
        'pendingFulfillment': true,
        'Pending Fulfillment': true,
        'Pending Fulfillment/Pending Billing': true
    };

    var LOCKED_FIELD_GUARDS = [
        { field: 'item',           label: 'Item' },
        { field: 'quantity',       label: 'Quantity' },
        { field: 'location',       label: 'Line Location' },
        { field: FIELD.METHOD,     label: 'Sourcing Method' },
        { field: FIELD.FROM_LOC,   label: 'Source From Location' },
        { field: FIELD.QTY_TRANSFER, label: 'Qty to Transfer' }
    ];

    // ---------- Entry points ----------

    function beforeLoad(context) {
        try {
            if (context.type === context.UserEventType.CREATE) {
                cleanupCreateModeSourcingFields(context.newRecord);
            }

            if (context.type !== context.UserEventType.VIEW) return;
            injectViewModePickerButtons(context.form, context.newRecord);
        } catch (e) {
            log.error('beforeLoad:viewPicker failed', e);
        }
    }

    function beforeSubmit(context) {
        var T = context.UserEventType;
        var rec = context.newRecord;
        var oldRec = context.oldRecord;

        log.debug('beforeSubmit:start', { type: context.type, hasOld: !!oldRec });

        // ----- DELETE -----
        if (context.type === T.DELETE) {
            blockDeleteIfActiveLinkedTOs(oldRec || rec);
            return;
        }

        // ----- COPY (record-level "Make Copy") -----
        if (context.type === T.COPY) {
            log.debug('beforeSubmit:COPY', { soId: rec.id });
            cleanupAllLines(rec);
            validateAllLines(rec);
            return;
        }

        // ----- CREATE / EDIT / XEDIT -----
        if (context.type === T.CREATE || context.type === T.EDIT || context.type === T.XEDIT) {

            // Detect line-level copies (Copy Line button) — newly inserted lines
            // that have processed=true or linked_to set from the copy source.
            cleanupCopiedLines(rec);

            // Per-line validation
            validateAllLines(rec);

            if (oldRec) {
                enforceLockRestrictions(oldRec, rec);
                enforceHeaderRestrictions(oldRec, rec);
                blockCloseCancelIfActiveLinkedTOs(oldRec, rec);
            }
        }
    }

    function afterSubmit(context) {
        try {
            var T = context.UserEventType;
            if (context.type !== T.CREATE && context.type !== T.EDIT &&
                context.type !== T.XEDIT && context.type !== T.COPY) return;

            var ctxType = runtime.executionContext;
            var allowed = [runtime.ContextType.USER_INTERFACE, runtime.ContextType.WORKFLOW];
            if (allowed.indexOf(ctxType) === -1) {
                log.debug('afterSubmit:skipContext', { context: ctxType });
                return;
            }

            var soId = context.newRecord.id;
            if (context.type !== T.XEDIT && !hasReadyTOSourcingLines(context.newRecord)) {
                log.debug('afterSubmit:skipNoReadyLines', { soId: soId });
                return;
            }

            var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
	
            var status = so.getValue({ fieldId: 'orderstatus' }) || so.getValue({ fieldId: 'status' });
            if (!isPendingFulfillmentStatus(status)) {
                log.debug('afterSubmit:skipStatus', { status: status });
                return;
            }
            if (!hasReadyTOSourcingLines(so)) {
                log.debug('afterSubmit:skipNoReadyLinesLoaded', { soId: soId });
                return;
            }
	
            runSourcingEngine(so);
        } catch (e) {
            log.error('afterSubmit failed', e);
        }
    }

    // ---------- View mode picker ----------

    function injectViewModePickerButtons(form, rec) {
        if (!form || !rec) return;

        var lines = buildViewModePickerLines(rec);
        var hasButtons = lines.some(function (line) { return line && line.show; });
        if (!hasButtons) return;

        var field = form.addField({
            id: 'custpage_bc_view_picker_buttons',
            type: serverWidget.FieldType.INLINEHTML,
            label: ' '
        });
        field.defaultValue = buildViewModePickerHtml(lines);
    }

    function buildViewModePickerLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' }) || '';
        var headerLocation = rec.getValue({ fieldId: 'location' }) || '';
        var soId = rec.id || '';
        var lines = [];

        for (var i = 0; i < lineCount; i++) {
            var method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            if (method !== SOURCING_METHOD_TO) {
                lines.push({ show: false });
                continue;
            }

            var item = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'item', line: i }) || '';
            var qtyRequired = getQtyRequired(rec, i);
            var destLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: i }) || headerLocation;
            var fromLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: i }) || '';
            var lineId = getLineId(rec, i) || String(i);
            var line = {
                show: true,
                label: fromLoc ? 'View Source' : 'View Locations',
                url: '',
                message: ''
            };

            if (!item) {
                line.message = 'This line has no item selected.';
            } else if (!qtyRequired || qtyRequired <= 0) {
                line.message = 'This line has no backordered quantity or line quantity to inspect.';
            } else if (!destLoc) {
                line.message = 'This Sales Order line needs a destination Location before the picker can open.';
            } else if (!subsidiary) {
                line.message = 'This Sales Order needs a Subsidiary before the picker can open.';
            } else {
                var params = {
                    itemId: item,
                    qtyRequired: qtyRequired,
                    destLocationId: destLoc,
                    subsidiaryId: subsidiary,
                    readOnly: 'T',
                    soId: soId,
                    lineId: lineId
                };
                if (fromLoc) params.selectedLocId = fromLoc;

                line.url = url.resolveScript({
                    scriptId: PICKER_SCRIPT_ID,
                    deploymentId: PICKER_DEPLOY_ID,
                    params: params
                });
            }

            lines.push(line);
        }

        return lines;
    }

    function buildViewModePickerHtml(lines) {
        var data = safeInlineJson({ lines: lines });
        return [
            '<script type="text/javascript">',
            '(function(){',
            'var cfg=' + data + ';',
            'var BTN_CELL_CLASS="bc-view-pick-loc-cell";',
            'var BTN_CLASS="bc-view-pick-loc-btn";',
            'var STYLE="padding:3px 10px;font-size:11px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;white-space:nowrap;";',
            'function findTable(){',
            '  return document.getElementById("item_splits") || document.querySelector("table[id*=item]");',
            '}',
            'function getRows(table){',
            '  var rows=table.querySelectorAll("tbody tr[id^=item_row_], tbody tr[id^=itemrow], tr[id^=item_row_], tr[id^=itemrow]");',
            '  if(rows.length) return Array.prototype.slice.call(rows).filter(function(r){return r.querySelectorAll("td").length;});',
            '  return Array.prototype.slice.call(table.querySelectorAll("tbody tr")).filter(function(r){',
            '    return r.querySelectorAll("td").length>1 && !(r.className||"").match(/header|total/i);',
            '  });',
            '}',
            'function ensureHeader(table){',
            '  var row=table.querySelector("thead tr") || table.querySelector("tr.uir-machine-headerrow") || table.querySelector("tr.listheader");',
            '  if(!row || row.querySelector("."+BTN_CELL_CLASS)) return;',
            '  var cell=document.createElement(row.querySelector("th") ? "th" : "td");',
            '  cell.className=BTN_CELL_CLASS;',
            '  cell.style.padding="2px 6px";',
            '  cell.style.whiteSpace="nowrap";',
            '  cell.textContent="Source";',
            '  row.appendChild(cell);',
            '}',
            'function openLine(idx){',
            '  var line=cfg.lines[idx];',
            '  if(!line) return false;',
            '  if(!line.url){ alert(line.message || "The picker cannot open for this line."); return false; }',
            '  var w=window.open(line.url,"bc_inventory_picker","width=820,height=560,resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no");',
            '  if(!w) alert("Allow popups from NetSuite and try again.");',
            '  return false;',
            '}',
            'window.bcViewOpenPicker=openLine;',
            'function inject(){',
            '  var table=findTable();',
            '  if(!table) return;',
            '  ensureHeader(table);',
            '  var rows=getRows(table);',
            '  for(var i=0;i<rows.length && i<cfg.lines.length;i++){',
            '    var row=rows[i];',
            '    var line=cfg.lines[i];',
            '    var cell=row.querySelector("td."+BTN_CELL_CLASS);',
            '    if(!cell){',
            '      cell=document.createElement("td");',
            '      cell.className=BTN_CELL_CLASS;',
            '      cell.style.padding="2px 6px";',
            '      cell.style.whiteSpace="nowrap";',
            '      row.appendChild(cell);',
            '    }',
            '    if(line && line.show){',
            '      var label=line.label || "View Locations";',
            '      var existing=cell.querySelector("button."+BTN_CLASS);',
            '      if(existing && existing.getAttribute("data-bc-line")===String(i) && existing.textContent===label) continue;',
            '      cell.innerHTML="";',
            '      var btn=document.createElement("button");',
            '      btn.type="button";',
            '      btn.className=BTN_CLASS;',
            '      btn.style.cssText=STYLE;',
            '      btn.textContent=label;',
            '      btn.setAttribute("data-bc-line",String(i));',
            '      btn.onclick=(function(idx){return function(){return openLine(idx);};})(i);',
            '      cell.appendChild(btn);',
            '    } else if(cell.innerHTML){',
            '      cell.innerHTML="";',
            '    }',
            '  }',
            '}',
            'function start(){',
            '  inject();',
            '  var delays=[50,150,400,1000,2000];',
            '  for(var i=0;i<delays.length;i++) setTimeout(inject,delays[i]);',
            '  try{new MutationObserver(function(){inject();}).observe(document.body,{childList:true,subtree:true});}catch(e){}',
            '}',
            'if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",start); else start();',
            '})();',
            '</script>'
        ].join('');
    }

    function safeInlineJson(value) {
        return JSON.stringify(value)
            .replace(/</g, '\\u003c')
            .replace(/>/g, '\\u003e')
            .replace(/&/g, '\\u0026')
            .replace(/\u2028/g, '\\u2028')
            .replace(/\u2029/g, '\\u2029');
    }

    // ---------- Validation ----------

    function validateAllLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            validateLine(rec, i);
        }
    }

    function validateLine(rec, lineIdx) {
        var method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: lineIdx }) || '');
        if (method !== SOURCING_METHOD_TO) return;

        var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: lineIdx });
        var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: lineIdx });
        if (processed || linkedTo) return;

        var lineNum = lineIdx + 1;

        var itemType = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'itemtype', line: lineIdx });
        if (itemType && !ALLOWED_ITEM_TYPES[itemType]) {
            throw new Error('Line ' + lineNum + ': item type "' + itemType + '" not supported for Transfer Order sourcing. Only Inventory and Assembly items are supported.');
        }

        var isSpecialOrder = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'createpo', line: lineIdx });
        if (isSpecialOrder) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a line that also has Special Order / Drop Ship configured.');
        }
        var isDropShip = false;
        try {
            isDropShip = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'createdropship', line: lineIdx });
        } catch (dropShipFieldErr) {}
        if (isDropShip) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a Drop Ship line.');
        }
        var poVendor = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'povendor', line: lineIdx });
        if (poVendor) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a line with a PO Vendor populated.');
        }
	
        var fromLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: lineIdx });
        if (!fromLoc) {
            throw new Error('Line ' + lineNum + ': Source From Location is required for Transfer Order sourcing. Use the Inventory Picker before saving/approving.');
        }
	
        var lineDestLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: lineIdx })
                       || rec.getValue({ fieldId: 'location' });
        if (!lineDestLoc) {
            throw new Error('Line ' + lineNum + ': destination Location is required before Transfer Order sourcing can be used.');
        }
        if (String(fromLoc) === String(lineDestLoc)) {
            throw new Error('Line ' + lineNum + ': Source From Location cannot equal the destination Location.');
        }
    }

    // ---------- Lock enforcement ----------

    function enforceLockRestrictions(oldRec, newRec) {
        var oldLocked = buildLockedLineMap(oldRec);
        if (!hasAny(oldLocked)) return;

        var newLineMap = buildLineIdMap(newRec);

        Object.keys(oldLocked).forEach(function (lineId) {
            var oldLine = oldLocked[lineId];
            var newIdx = newLineMap[lineId];

            // Deleted?
            if (newIdx === undefined || newIdx === null) {
                throw new Error('Cannot delete line ' + oldLine.lineNum +
                    ': a Transfer Order is linked to this line. To remove the line, an Administrator must first cancel the linked TO and clear the Linked TO, Sourcing Processed, and Sourcing Error fields.');
            }

            var newProcessed = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: newIdx });
            var newLinkedTo = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: newIdx });
            var stillLocked = !!newProcessed || !!newLinkedTo;

            // Partial unlock attempt (cleared one but not the other)
            var oldProcessed = oldLine.values[FIELD.PROCESSED];
            var oldLinkedTo = oldLine.values[FIELD.LINKED_TO];
            var partialClear = (oldProcessed && !newProcessed && newLinkedTo) ||
                               (oldLinkedTo && !newLinkedTo && newProcessed);
            if (partialClear) {
                throw new Error('Line ' + oldLine.lineNum + ': to unlock, clear BOTH the Linked Transfer Order AND the Sourcing Processed flag. Partial clearing is not allowed.');
            }

            // Admin correction unlock = both fields cleared. Only allow after
            // the linked TO is Cancelled. Closed/received/active TOs remain
            // the audit trail and require operational correction first.
            if (!stillLocked) {
                validateAdminUnlockAllowed(oldLine);
                return;
            }

            // Field change check
            for (var k = 0; k < LOCKED_FIELD_GUARDS.length; k++) {
                var guard = LOCKED_FIELD_GUARDS[k];
                var oldVal = oldLine.values[guard.field];
                var newVal = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: guard.field, line: newIdx });

                if (String(oldVal == null ? '' : oldVal) !== String(newVal == null ? '' : newVal)) {
                    throw new Error('Cannot change "' + guard.label + '" on line ' + oldLine.lineNum +
                        ': a Transfer Order is linked to this line. To modify, an Administrator must first cancel the linked TO and clear the Linked TO and Sourcing Processed fields.');
                }
            }
        });
    }

    function enforceHeaderRestrictions(oldRec, newRec) {
        var oldSub = oldRec.getValue({ fieldId: 'subsidiary' });
        var newSub = newRec.getValue({ fieldId: 'subsidiary' });
        var oldLoc = oldRec.getValue({ fieldId: 'location' });
        var newLoc = newRec.getValue({ fieldId: 'location' });
        var subChanged = String(oldSub || '') !== String(newSub || '');
        var locChanged = String(oldLoc || '') !== String(newLoc || '');
        if (!subChanged && !locChanged) return;

        var blockingLines = getActiveLinkedTOLines(newRec);
        if (!blockingLines.length) return;

        if (subChanged) {
            throw new Error('Cannot change Subsidiary: this SO has active linked Transfer Orders. Cancel or operationally reverse them first: ' + blockingLines.join('; '));
        }
        if (locChanged) {
            throw new Error('Cannot change header Location: this SO has active linked Transfer Orders. Cancel or operationally reverse them first: ' + blockingLines.join('; '));
        }
    }

    function validateAdminUnlockAllowed(oldLine) {
        if (!isCurrentUserAdministrator()) {
            throw new Error('Line ' + oldLine.lineNum + ': only an Administrator can clear Linked Transfer Order and Sourcing Processed.');
        }

        var linkedTo = oldLine.values[FIELD.LINKED_TO];
        if (!linkedTo) return;

        var statusVal = getTransferOrderStatusValue(linkedTo);
        if (!statusVal) {
            throw new Error('Line ' + oldLine.lineNum + ': cannot unlock because linked Transfer Order status could not be verified.');
        }
        if (!CANCELLED_TO_STATUSES[statusVal]) {
            throw new Error('Line ' + oldLine.lineNum + ': linked Transfer Order must be Cancelled before clearing Linked Transfer Order and Sourcing Processed. Current status: ' + statusVal + '.');
        }
    }

    function isCurrentUserAdministrator() {
        try {
            var user = runtime.getCurrentUser();
            return String(user.role) === '3' || String(user.roleId || '').toLowerCase() === 'administrator';
        } catch (e) {
            return false;
        }
    }

    function getTransferOrderStatusValue(toId) {
        try {
            var look = search.lookupFields({
                type: record.Type.TRANSFER_ORDER,
                id: toId,
                columns: ['status']
            });
            return look.status && look.status[0] ? (look.status[0].value || look.status[0].text || '') : '';
        } catch (e) {
            log.error('getTransferOrderStatusValue failed', { toId: toId, error: e.message });
            return '';
        }
    }

    // ---------- Close/cancel block (hardened) ----------

    function blockCloseCancelIfActiveLinkedTOs(oldRec, newRec) {
        var oldStatus = String(oldRec.getValue({ fieldId: 'orderstatus' }) || oldRec.getValue({ fieldId: 'status' }) || '');
        var newStatus = String(newRec.getValue({ fieldId: 'orderstatus' }) || newRec.getValue({ fieldId: 'status' }) || '');

        log.debug('closeCheck:statuses', { oldStatus: oldStatus, newStatus: newStatus });

        // Check header-level status transition into closed-ish
        var headerClosed = (oldStatus !== newStatus) && SO_CLOSED_STATUSES[newStatus];

        // Check line-level: any locked line that got its "isclosed" checkbox flipped to T
        var lineClosed = checkAnyLockedLineClosing(oldRec, newRec);

        if (headerClosed || lineClosed) {
            var blockingLines = getActiveLinkedTOLines(newRec);
            if (blockingLines.length) {
                throw new Error('Cannot close/cancel: the following lines have active Transfer Orders that must be cancelled or operationally reversed first: ' + blockingLines.join('; '));
            }
        }
    }

    /**
     * Detect closure via line-level isclosed flag flipping to true on a locked line.
     */
    function checkAnyLockedLineClosing(oldRec, newRec) {
        try {
            var oldMap = buildLockedLineMap(oldRec);
            var newLineMap = buildLineIdMap(newRec);

            for (var lineId in oldMap) {
                if (!oldMap.hasOwnProperty(lineId)) continue;
                var newIdx = newLineMap[lineId];
                if (newIdx === undefined) continue;

                var oldClosed = oldRec.getSublistValue({ sublistId: SUBLIST, fieldId: 'isclosed', line: indexOfLineId(oldRec, lineId) });
                var newClosed = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: 'isclosed', line: newIdx });
                if (!oldClosed && newClosed) return true;
            }
        } catch (e) {
            log.error('checkAnyLockedLineClosing failed', e);
        }
        return false;
    }

    function indexOfLineId(rec, targetId) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            if (String(getLineId(rec, i)) === String(targetId)) return i;
        }
        return -1;
    }

    function blockDeleteIfActiveLinkedTOs(rec) {
        var blockingLines = getActiveLinkedTOLines(rec);
        if (blockingLines.length) {
            throw new Error('Cannot delete this SO: ' + blockingLines.join('; ') + '. An Administrator must cancel or operationally reverse the linked TO(s) first.');
        }
    }

    function getActiveLinkedTOLines(rec) {
        var blocking = [];
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            if (!linkedTo) continue;

            try {
                var look = search.lookupFields({
                    type: record.Type.TRANSFER_ORDER,
                    id: linkedTo,
                    columns: ['status', 'tranid']
                });
                var statusVal = look.status && look.status[0] ? (look.status[0].value || look.status[0].text || '') : '';
                if (ACTIVE_TO_STATUSES[statusVal]) {
                    blocking.push('Line ' + (i + 1) + ' (' + (look.tranid || ('TO#' + linkedTo)) + ', status ' + statusVal + ')');
                }
            } catch (e) {
                log.error('getActiveLinkedTOLines:lookup', e);
            }
        }
        return blocking;
    }

    // ---------- Copy cleanup ----------

    /**
     * Record-level COPY (Actions → Make Copy): clear linkage + sourcing inputs
     * on every line. Keep method so TO-method lines show the Pick Location
     * button on the new SO, prompting the user to re-pick source locations.
     */
    function cleanupAllLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO,    line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED,    line: i, value: false });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR,        line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC,     line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, line: i, value: '' });
            // Method left as-is
        }
    }

    /**
     * CREATE mode can inherit line custom fields when users copy or transform
     * transactions. Clear all sourcing customization fields before the form is
     * shown so users deliberately choose sourcing on the new SO.
     */
    function cleanupCreateModeSourcingFields(rec) {
        if (!rec) return;

        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        log.debug('lineCount', lineCount)
        for (var i = 0; i < lineCount; i++) {
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD,       line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC,     line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO,    line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED,    line: i, value: false });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR,        line: i, value: '' });
        }
    }

    /**
     * Line-level Copy: NetSuite gives copied lines no database `line` ID (it's
     * a new insert from the user's perspective). If we see a "new" line carrying
     * processed=true OR a linked_to value, it's a line-copy artifact.
     *
     * Clear: linked_to, processed, error, from_location, qty_to_transfer.
     * Keep:  sourcing_method (so the Pick Location button surfaces if method=TO,
     *        prompting the user to deliberately re-pick a source location).
     *
     * The client script already does this on lineInit for immediate UX feedback;
     * this is the server-side belt-and-suspenders for the case where the user
     * skipped re-picking before saving (or for non-UI contexts).
     */
    function cleanupCopiedLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            var dbLineId = null;
            try {
                dbLineId = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'line', line: i });
            } catch (e) {}

            if (!dbLineId) {
                var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i });
                var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
                if (processed || linkedTo) {
                    log.audit('cleanupCopiedLines:wipeNewLine', { lineIdx: i });
                    rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO,    line: i, value: '' });
                    rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED,    line: i, value: false });
                    rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR,        line: i, value: '' });
                    rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC,     line: i, value: '' });
                    rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, line: i, value: '' });
                    // Method left as-is intentionally
                }
            }
        }
    }

    // ---------- Sourcing engine ----------

    function runSourcingEngine(so) {
        var soId = so.id;
        var tranId = so.getValue({ fieldId: 'tranid' }) || '';
        var subsidiary = so.getValue({ fieldId: 'subsidiary' });
        var headerLocation = so.getValue({ fieldId: 'location' });
	
        var collected = collectQualifyingLines(so, headerLocation);
        var qualifying = collected.lines;
        var configSkipped = collected.skipped;
        if (!headerLocation && qualifying.length) {
            qualifying.forEach(function (line) {
                line.skip = true;
                line.error = 'Transfer Order sourcing skipped: SO header Location is required as the TO destination.';
                configSkipped.push(line);
            });
            qualifying = [];
        }
        if (!qualifying.length) {
            if (configSkipped.length) writebackResults(so, [], [], configSkipped);
            log.debug('engine:noQualifyingLines', { soId: soId, skipped: configSkipped.length });
            return;
        }
        var checked = recheckAvailability(qualifying);

        var groups = {};
        var skipped = configSkipped.slice(0);
        checked.forEach(function (line) {
            if (line.skip) { skipped.push(line); return; }
            if (!groups[line.fromLoc]) groups[line.fromLoc] = [];
            groups[line.fromLoc].push(line);
        });

        var success = [];
        var failed = [];
        Object.keys(groups).forEach(function (fromLocId) {
            var grp = groups[fromLocId];
            try {
                var toId = createTransferOrder(subsidiary, fromLocId, headerLocation, grp, tranId, soId);
                grp.forEach(function (l) { success.push({ lineIdx: l.lineIdx, toId: toId }); });
                log.audit('engine:toCreated', { fromLocId: fromLocId, toId: toId, lines: grp.length });
            } catch (e) {
                log.error('engine:toCreateFailed', { fromLocId: fromLocId, error: e.message });
                grp.forEach(function (l) { failed.push({ lineIdx: l.lineIdx, error: 'TO creation failed: ' + e.message }); });
            }
        });

        writebackResults(so, success, failed, skipped);
        log.audit('engine:done', { soId: soId, success: success.length, failed: failed.length, skipped: skipped.length });
    }

    function collectQualifyingLines(so, headerLocation) {
        var lineCount = so.getLineCount({ sublistId: SUBLIST });
        var lines = [];
        var skipped = [];
        for (var i = 0; i < lineCount; i++) {
            var method = String(so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            if (method !== SOURCING_METHOD_TO) continue;
            if (so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i })) continue;
            if (so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i })) continue;

            var fromLoc = so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: i });
            if (!fromLoc) {
                skipped.push({
                    lineIdx: i,
                    lineNum: i + 1,
                    error: 'Transfer Order sourcing skipped: Source From Location is not selected.'
                });
                continue;
            }
            var item = so.getSublistValue({ sublistId: SUBLIST, fieldId: 'item', line: i });
            if (!item) continue;

            var qtyRequired = getQtyRequired(so, i);
            if (qtyRequired <= 0) continue;

            lines.push({
                lineIdx: i, lineNum: i + 1,
                item: item, fromLoc: fromLoc,
                destLoc: so.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: i }) || headerLocation,
                qtyRequired: qtyRequired,
                units: so.getSublistValue({ sublistId: SUBLIST, fieldId: 'units', line: i })
            });
        }
        return { lines: lines, skipped: skipped };
    }

    function recheckAvailability(lines) {
        var pairs = {};
        lines.forEach(function (l) { pairs[l.item + '|' + l.fromLoc] = { item: l.item, location: l.fromLoc }; });
        var itemIds = [];
        var locIds = [];
        Object.keys(pairs).forEach(function (key) {
            itemIds.push(pairs[key].item);
            locIds.push(pairs[key].location);
        });

        var availMap = {};
        if (itemIds.length && locIds.length) {
            try {
                var s = search.create({
                    type: 'inventorybalance',
                    filters: [['item', 'anyof', unique(itemIds)], 'AND', ['location', 'anyof', unique(locIds)]],
                    columns: [
                        search.createColumn({ name: 'item' }),
                        search.createColumn({ name: 'location' }),
                        search.createColumn({ name: INVBAL_AVAILABLE_FIELD })
                    ]
                });
                s.run().each(function (r) {
                    var item = r.getValue({ name: 'item' });
                    var loc = r.getValue({ name: 'location' });
                    var key = item + '|' + loc;
                    availMap[key] = (availMap[key] || 0) + parseFloat(r.getValue({ name: INVBAL_AVAILABLE_FIELD }) || '0');
                    return true;
                });
            } catch (e) {
                log.error('recheckAvailability:batchSearchFailed', e);
            }
        }
        return lines.map(function (l) {
            var avail = availMap[l.item + '|' + l.fromLoc] || 0;
            if (avail < l.qtyRequired) {
                l.skip = true;
                l.error = 'Availability dropped: requested ' + l.qtyRequired + ', available ' + avail + ' at source location at time of TO creation.';
            }
            return l;
        });
    }

    function createTransferOrder(subsidiary, fromLocId, toLocId, groupLines, soTranId, soId) {
        var to = record.create({ type: record.Type.TRANSFER_ORDER, isDynamic: true });
        if (subsidiary) to.setValue({ fieldId: 'subsidiary', value: subsidiary });
        to.setValue({ fieldId: 'location', value: fromLocId });
        to.setValue({ fieldId: 'transferlocation', value: toLocId });
        to.setValue({ fieldId: 'memo', value: 'Auto-created from SO #' + (soTranId || soId) });
        var orderStatus = getScriptParam(PARAM_TO_ORDER_STATUS, DEFAULT_TO_ORDER_STATUS);
        if (orderStatus) {
            try { to.setValue({ fieldId: 'orderstatus', value: orderStatus }); } catch (e) {}
        }
        var sourceSoField = getScriptParam(PARAM_TO_SOURCE_SO_FIELD, DEFAULT_TO_SOURCE_SO_FIELD);
        if (sourceSoField) {
            try { to.setValue({ fieldId: sourceSoField, value: soId }); } catch (e) {
                log.debug('createTransferOrder:sourceSOFieldSkipped', { fieldId: sourceSoField, error: e.message });
            }
        }
	
        groupLines.forEach(function (line) {
            to.selectNewLine({ sublistId: 'item' });
            to.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: line.item });
            to.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: line.qtyRequired });
            if (line.units) {
                try { to.setCurrentSublistValue({ sublistId: 'item', fieldId: 'units', value: line.units }); } catch (e) {}
            }
            to.commitLine({ sublistId: 'item' });
        });
        return to.save({ ignoreMandatoryFields: false });
    }

    function writebackResults(so, success, failed, skipped) {
        if (!success.length && !failed.length && !skipped.length) return;
        var changed = false;
        success.forEach(function (s) {
            changed = setLineValueIfChanged(so, FIELD.LINKED_TO, s.lineIdx, s.toId) || changed;
            changed = setLineValueIfChanged(so, FIELD.PROCESSED, s.lineIdx, true) || changed;
            changed = setLineValueIfChanged(so, FIELD.ERROR, s.lineIdx, '') || changed;
        });
        failed.forEach(function (f) {
            changed = setLineValueIfChanged(so, FIELD.ERROR, f.lineIdx, f.error) || changed;
        });
        skipped.forEach(function (l) {
            changed = setLineValueIfChanged(so, FIELD.ERROR, l.lineIdx, l.error) || changed;
        });
        if (changed) so.save({ ignoreMandatoryFields: true, enableSourcing: false });
    }

    function setLineValueIfChanged(rec, fieldId, lineIdx, value) {
        var oldVal = rec.getSublistValue({ sublistId: SUBLIST, fieldId: fieldId, line: lineIdx });
        if (String(oldVal == null ? '' : oldVal) === String(value == null ? '' : value)) return false;
        rec.setSublistValue({ sublistId: SUBLIST, fieldId: fieldId, line: lineIdx, value: value });
        return true;
    }

    function getQtyRequired(rec, lineIdx) {
        var qtyToTransfer = parseFloat(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, line: lineIdx }) || '0');
        if (qtyToTransfer > 0) return qtyToTransfer;

        var bo = parseFloat(rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered', line: lineIdx }) || '0');
        if (bo > 0) return bo;

        return parseFloat(rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantity', line: lineIdx }) || '0');
    }

    function isPendingFulfillmentStatus(status) {
        return !!SO_PENDING_FULFILLMENT_STATUSES[String(status || '')];
    }

    function hasReadyTOSourcingLines(rec) {
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return true; }
        if (!lineCount) return true;

        for (var i = 0; i < lineCount; i++) {
            var method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            if (method !== SOURCING_METHOD_TO) continue;
            if (rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i })) continue;
            if (rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i })) continue;
            if (rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: i })) continue;
            if (!rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: i })) continue;
            if (getQtyRequired(rec, i) > 0) return true;
        }
        return false;
    }

    function getScriptParam(paramId, defaultValue) {
        try {
            var value = runtime.getCurrentScript().getParameter({ name: paramId });
            return value || defaultValue || '';
        } catch (e) {
            return defaultValue || '';
        }
    }

    function unique(values) {
        var seen = {};
        var out = [];
        values.forEach(function (value) {
            var key = String(value || '');
            if (!key || seen[key]) return;
            seen[key] = true;
            out.push(value);
        });
        return out;
    }

    // ---------- Diff helpers ----------

    function buildLockedLineMap(rec) {
        var map = {};
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i });
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            if (!processed && !linkedTo) continue;

            var id = getLineId(rec, i);
            if (!id) continue;

            var values = {};
            LOCKED_FIELD_GUARDS.forEach(function (g) {
                values[g.field] = rec.getSublistValue({ sublistId: SUBLIST, fieldId: g.field, line: i });
            });
            values[FIELD.PROCESSED] = processed;
            values[FIELD.LINKED_TO] = linkedTo;

            map[id] = { lineNum: i + 1, values: values };
        }
        return map;
    }

    function buildLineIdMap(rec) {
        var map = {};
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            var id = getLineId(rec, i);
            if (id) map[id] = i;
        }
        return map;
    }

    function getLineId(rec, lineIdx) {
        try {
            var id = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'line', line: lineIdx });
            if (id) return String(id);
        } catch (e) {}
        try {
            var u = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'lineuniquekey', line: lineIdx });
            if (u) return String(u);
        } catch (e) {}
        return null;
    }

    function anyLinkedTOsInRecord(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            if (rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i })) return true;
        }
        return false;
    }

    function hasAny(obj) {
        for (var k in obj) if (obj.hasOwnProperty(k)) return true;
        return false;
    }

    return {
        beforeLoad: beforeLoad,
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
