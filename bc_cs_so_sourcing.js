/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script (with saveRecord lock enforcement)
 *
 * Capabilities:
 *   - Inject "Pick Location" buttons into the item sublist DOM
 *   - Manage method/qty/from-location field interactions
 *   - Open inventory picker popup, receive selection
 *   - Capture a SNAPSHOT of locked line values on pageInit so saveRecord can
 *     compare current values and BLOCK before round-tripping to the server
 *   - Block header subsidiary / location changes when linked TOs exist
 *   - Block close/cancel attempts client-side too
 */
define(['N/url', 'N/currentRecord', 'N/ui/dialog', 'N/search'], function (url, currentRecord, dialog, search) {

    var DEBUG = true;

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

    var ALLOWED_ITEM_TYPES = { 'InvtPart': true, 'Assembly': true };

    var PICKER_SCRIPT_ID = 'customscript_bc_sl_inventory_picker';
    var PICKER_DEPLOY_ID = 'customdeploy_bc_sl_inventory_picker';

    var BTN_CLASS = 'bc-pick-loc-btn';
    var BTN_CELL_CLASS = 'bc-pick-loc-cell';

    var INJECT_DEBOUNCE_MS = 30;
    var INITIAL_RETRY_DELAYS = [50, 150, 400, 1000];

    // SO closed-ish statuses (parallel to UE)
    var CLOSED_STATUSES = {
        'F': true, 'closedOrder': true, 'closed': true,
        'H': true, 'cancelled': true,
        'SalesOrd:F': true, 'SalesOrd:H': true,
        'Closed': true, 'Cancelled': true
    };

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

    var LOCKED_FIELD_GUARDS = [
        { field: 'item',             label: 'Item' },
        { field: 'quantity',         label: 'Quantity' },
        { field: 'location',         label: 'Line Location' },
        { field: FIELD.METHOD,       label: 'Sourcing Method' },
        { field: FIELD.FROM_LOC,     label: 'Source From Location' },
        { field: FIELD.QTY_TRANSFER, label: 'Qty to Transfer' }
    ];

    // Snapshot of original values for locked lines, taken at pageInit
    var lockedSnapshot = null; // { lineId -> { lineNum, values } }
    var originalHeader = null; // { subsidiary, location, status }
    var pageMode = null;        // 'create' | 'edit' | 'copy' | 'view'
    var pendingPickerLineIndex = null;
    var observer = null;
    var injectTimer = null;

    // ---------------- Logging ----------------

    function dbg(t, o) { if (DEBUG) try { console.log('[BC SO Sourcing]', t, o || ''); } catch (e) {} }
    function logErr(t, e, x) { try { console.error('[BC SO Sourcing]', t, e, x || ''); } catch (z) {} }

    // ---------------- Entry points ----------------

    function pageInit(context) {
        pageMode = (context && context.mode) || null;
        dbg('pageInit', { mode: pageMode });

        var rec = currentRecord.get();

        // Snapshot original state for diff-based blocks
        try {
            lockedSnapshot = buildLockedSnapshot(rec);
            originalHeader = {
                subsidiary: rec.getValue({ fieldId: 'subsidiary' }),
                location: rec.getValue({ fieldId: 'location' }),
                status: rec.getValue({ fieldId: 'orderstatus' }) || rec.getValue({ fieldId: 'status' })
            };
            dbg('pageInit:snapshot', { lockedLines: Object.keys(lockedSnapshot).length, header: originalHeader });
        } catch (e) {
            logErr('pageInit:snapshot failed', e);
        }

        // Picker callbacks
        window.bcPickerCallback = function (payload) { handlePickerSelection(payload); };
        window.bcOpenPicker = function (lineIndex) {
            try {
                var r = currentRecord.get();
                var targetLine = parseInt(lineIndex, 10);
                var currentLine = -1;
                var lineCount = 0;
                try { currentLine = r.getCurrentSublistIndex({ sublistId: SUBLIST }); } catch (ignoreCurrent) {}
                try { lineCount = r.getLineCount({ sublistId: SUBLIST }); } catch (ignoreCount) {}

                if (currentLine !== targetLine && targetLine < lineCount) {
                    r.selectLine({ sublistId: SUBLIST, line: targetLine });
                }
                if (canOpenPicker(r)) openPicker(r);
            } catch (e) { logErr('bcOpenPicker failed', e); }
        };

        window.addEventListener('message', function (event) {
            if (event && event.data && event.data.source === 'bc_picker') {
                handlePickerSelection(event.data);
            }
        }, false);

        initialInjectWithRetry(0);
        startObserver();
    }

    function lineInit(context) {
        if (!context || context.sublistId !== SUBLIST) return;

        try {
            var rec = context.currentRecord;

            // Detect line-copy: a current line with no database `line` id but
            // carrying processed=true or a linked_to value is a fresh copy of
            // a locked line. Clean it immediately so the user re-picks.
            var dbLineId = null;
            try {
                dbLineId = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'line' });
            } catch (e) {}

            if (!dbLineId) {
                var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
                var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });

                if (processed || linkedTo) {
                    dbg('lineInit:copyDetected:wipe');
                    // Clear linkage fields
                    rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO,    value: '',    ignoreFieldChange: true });
                    rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED,    value: false, ignoreFieldChange: true });
                    rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR,        value: '',    ignoreFieldChange: true });
                    // Clear sourcing inputs so user re-picks location + qty
                    rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC,     value: '',    ignoreFieldChange: true });
                    rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '',    ignoreFieldChange: true });
                    // Method (custcol_bc_sourcing_method) intentionally left as-is
                    // so if it was TO, the Pick Location button surfaces immediately
                    // on the new line.

                    // After Copy Line, NetSuite paints the new row asynchronously.
                    // Schedule a staircase of re-injects to catch whichever paint cycle wins.
                    setTimeout(injectButtonsNow, 50);
                    setTimeout(injectButtonsNow, 200);
                    setTimeout(injectButtonsNow, 600);
                }
            }
        } catch (e) {
            logErr('lineInit copy-detect failed', e);
        }

        scheduleInject(INJECT_DEBOUNCE_MS);
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST) {
            // Body-level field changed — could be subsidiary, location, status
            handleBodyFieldChange(context);
            return;
        }
        try {
            var rec = context.currentRecord;
            if (isLineLocked(rec)) {
                // Lock check happens at saveRecord, but UX nicety: notify if user changes
                // a locked-field on a locked line
                if (LOCKED_FIELD_GUARDS.some(function (g) { return g.field === context.fieldId; })) {
                    // Optionally show toast — for now, silent. saveRecord will block.
                }
            }
            if (context.fieldId === FIELD.METHOD) {
                handleMethodChange(rec);
                injectButtonsNow();
            }
        } catch (e) {
            logErr('fieldChanged failed', e, { field: context.fieldId });
        }
    }

    function postSourcing(context) {
        if (context.sublistId === SUBLIST) scheduleInject(INJECT_DEBOUNCE_MS);
    }

    function sublistChanged(context) {
        if (context && context.sublistId === SUBLIST) scheduleInject(INJECT_DEBOUNCE_MS);
    }

    function validateLine(context) {
        if (context.sublistId !== SUBLIST) return true;
        try {
            var ok = validateCurrentLineSourcingRules(context.currentRecord);
            if (ok) scheduleInject(INJECT_DEBOUNCE_MS);
            return ok;
        } catch (e) {
            logErr('validateLine failed', e);
            return true; // UE remains authoritative
        }
    }

    /**
     * saveRecord runs before any submit. Return false to block save.
     * This is the client-side mirror of the UE beforeSubmit lock checks.
     */
    function saveRecord(context) {
        try {
            var rec = context.currentRecord;

            if (!validateCommittedLineSourcingRules(rec)) return false;

            // 1. Header subsidiary / location change and close/cancel checks
            if (originalHeader) {
                var newSub = rec.getValue({ fieldId: 'subsidiary' });
                var newLoc = rec.getValue({ fieldId: 'location' });
                var newStatus = rec.getValue({ fieldId: 'orderstatus' }) || rec.getValue({ fieldId: 'status' });
                var subChanged = String(originalHeader.subsidiary || '') !== String(newSub || '');
                var locChanged = String(originalHeader.location || '') !== String(newLoc || '');
                var closing = String(originalHeader.status || '') !== String(newStatus || '') && CLOSED_STATUSES[newStatus];

                if (subChanged || locChanged || closing) {
                    var activeLinked = getActiveLinkedTOLinesClient(rec);
                    if (activeLinked.length && subChanged) {
                        dialog.alert({ title: 'Cannot Change Subsidiary', message: 'This SO has active linked Transfer Orders. Cancel or operationally reverse them first: ' + activeLinked.join('; ') });
                        return false;
                    }
                    if (activeLinked.length && locChanged) {
                        dialog.alert({ title: 'Cannot Change Header Location', message: 'This SO has active linked Transfer Orders. Cancel or operationally reverse them first: ' + activeLinked.join('; ') });
                        return false;
                    }
                    if (activeLinked.length && closing) {
                        dialog.alert({ title: 'Cannot Close/Cancel SO', message: 'This SO has active linked Transfer Orders. Cancel or operationally reverse them first: ' + activeLinked.join('; ') });
                        return false;
                    }
                }
            }
	
            // 2. Locked-line restrictions
            if (lockedSnapshot && hasAny(lockedSnapshot)) {
                var newLineMap = buildLineIdMapClient(rec);

                for (var lineId in lockedSnapshot) {
                    if (!lockedSnapshot.hasOwnProperty(lineId)) continue;
                    var oldLine = lockedSnapshot[lineId];
                    var newIdx = newLineMap[lineId];

                    if (newIdx === undefined || newIdx === null) {
                        dialog.alert({
                            title: 'Cannot Delete Line',
                            message: 'Line ' + oldLine.lineNum + ' has a linked Transfer Order. Clear the Linked TO and Sourcing Processed fields first (Admin only), then save.'
                        });
                        return false;
                    }

                    var newProc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: newIdx });
                    var newLinkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: newIdx });
                    var stillLocked = !!newProc || !!newLinkedTo;

                    if (!stillLocked) continue; // Admin unlocked, allow changes

                    // Partial unlock?
                    var oldProc = oldLine.values[FIELD.PROCESSED];
                    var oldLinked = oldLine.values[FIELD.LINKED_TO];
                    if ((oldProc && !newProc && newLinkedTo) || (oldLinked && !newLinkedTo && newProc)) {
                        dialog.alert({
                            title: 'Incomplete Unlock',
                            message: 'Line ' + oldLine.lineNum + ': clear BOTH Linked Transfer Order AND Sourcing Processed to unlock. Partial clearing is not allowed.'
                        });
                        return false;
                    }

                    for (var k = 0; k < LOCKED_FIELD_GUARDS.length; k++) {
                        var g = LOCKED_FIELD_GUARDS[k];
                        var oVal = oldLine.values[g.field];
                        var nVal = rec.getSublistValue({ sublistId: SUBLIST, fieldId: g.field, line: newIdx });
                        if (String(oVal == null ? '' : oVal) !== String(nVal == null ? '' : nVal)) {
                            dialog.alert({
                                title: 'Cannot Change ' + g.label,
                                message: 'Line ' + oldLine.lineNum + ' has a linked Transfer Order. To change ' + g.label + ', an Administrator must first cancel the linked TO and clear the Linked TO and Sourcing Processed fields on the line.'
                            });
                            return false;
                        }
                    }
                }
            }

            return true;
        } catch (e) {
            logErr('saveRecord check failed', e);
            return true; // Fail open — UE will catch
        }
    }

    // ---------------- Validation helpers ----------------

    function validateCurrentLineSourcingRules(rec) {
        var method = String(safeCurrentLineValue(rec, FIELD.METHOD) || '');
        if (method !== SOURCING_METHOD_TO) return true;

        var processed = safeCurrentLineValue(rec, FIELD.PROCESSED);
        var linkedTo = safeCurrentLineValue(rec, FIELD.LINKED_TO);
        if (processed || linkedTo) return true;

        var lineIdx = -1;
        try { lineIdx = rec.getCurrentSublistIndex({ sublistId: SUBLIST }); } catch (e) {}
        return validateSourcingRuleValues(rec, lineIdx, {
            itemType: safeCurrentLineValue(rec, 'itemtype'),
            createPo: safeCurrentLineValue(rec, 'createpo'),
            dropShip: safeCurrentLineValue(rec, 'createdropship'),
            poVendor: safeCurrentLineValue(rec, 'povendor'),
            fromLoc: safeCurrentLineValue(rec, FIELD.FROM_LOC),
            destLoc: safeCurrentLineValue(rec, 'location') || rec.getValue({ fieldId: 'location' })
        });
    }

    function validateCommittedLineSourcingRules(rec) {
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return true; }

        for (var i = 0; i < lineCount; i++) {
            var method = String(safeLineValue(rec, FIELD.METHOD, i) || '');
            if (method !== SOURCING_METHOD_TO) continue;

            var processed = safeLineValue(rec, FIELD.PROCESSED, i);
            var linkedTo = safeLineValue(rec, FIELD.LINKED_TO, i);
            if (processed || linkedTo) continue;

            var ok = validateSourcingRuleValues(rec, i, {
                itemType: safeLineValue(rec, 'itemtype', i),
                createPo: safeLineValue(rec, 'createpo', i),
                dropShip: safeLineValue(rec, 'createdropship', i),
                poVendor: safeLineValue(rec, 'povendor', i),
                fromLoc: safeLineValue(rec, FIELD.FROM_LOC, i),
                destLoc: safeLineValue(rec, 'location', i) || rec.getValue({ fieldId: 'location' })
            });
            if (!ok) return false;
        }
        return true;
    }

    function validateSourcingRuleValues(rec, lineIdx, values) {
        var lineLabel = lineIdx >= 0 ? ('Line ' + (lineIdx + 1)) : 'Current line';

        if (values.itemType && !ALLOWED_ITEM_TYPES[values.itemType]) {
            return validationAlert(
                'Unsupported Item Type',
                lineLabel + ': item type "' + values.itemType + '" is not supported for Transfer Order sourcing. Only Inventory and Assembly items are supported.'
            );
        }

        if (hasNativePOValue(values.createPo) || hasNativePOValue(values.dropShip)) {
            return validationAlert(
                'Native PO Conflict',
                lineLabel + ': cannot use Transfer Order sourcing on a line that also has Special Order / Drop Ship configured.'
            );
        }

        if (hasNativePOValue(values.poVendor)) {
            return validationAlert(
                'Native PO Conflict',
                lineLabel + ': cannot use Transfer Order sourcing on a line with a PO Vendor populated.'
            );
        }

        if (!values.destLoc) {
            return validationAlert(
                'Destination Location Required',
                lineLabel + ': destination Location is required before Transfer Order sourcing can be used.'
            );
        }

        if (!values.fromLoc) {
            return validationAlert(
                'Source Location Required',
                lineLabel + ': Source From Location is required for Transfer Order sourcing. Use the Inventory Picker before saving/approving.'
            );
        }

        if (String(values.fromLoc) === String(values.destLoc || '')) {
            return validationAlert(
                'Invalid Source Location',
                lineLabel + ': Source From Location cannot equal the destination Location.'
            );
        }

        return true;
    }

    function validationAlert(title, message) {
        dialog.alert({ title: title, message: message });
        return false;
    }

    function hasNativePOValue(value) {
        return !(value === null || value === undefined || value === '' ||
            value === false || value === 'F' || value === 'false');
    }

    function safeCurrentLineValue(rec, fieldId) {
        try { return rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: fieldId }); } catch (e) { return ''; }
    }

    function safeLineValue(rec, fieldId, lineIdx) {
        try { return rec.getSublistValue({ sublistId: SUBLIST, fieldId: fieldId, line: lineIdx }); } catch (e) { return ''; }
    }

    // ---------------- Handlers ----------------

    function handleMethodChange(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        if (method === SOURCING_METHOD_TO) {
            var qtyTransfer = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER });
            if (!qtyTransfer) {
                var lineQty = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' });
                if (lineQty) {
                    rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: lineQty, ignoreFieldChange: true });
                }
            }
        } else {
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: '', ignoreFieldChange: true });
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
        }
    }

    function handleBodyFieldChange(context) {
        // Currently passive — saveRecord catches everything. Could add live alerts here later.
    }

    function handlePickerSelection(payload) {
        try {
            var rec = currentRecord.get();
            if (pendingPickerLineIndex !== null) {
                var currentLine = -1;
                var lineCount = 0;
                try { currentLine = rec.getCurrentSublistIndex({ sublistId: SUBLIST }); } catch (ignoreCurrent) {}
                try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (ignoreCount) {}
                if (currentLine !== pendingPickerLineIndex && pendingPickerLineIndex < lineCount) {
                    rec.selectLine({ sublistId: SUBLIST, line: pendingPickerLineIndex });
                }
            }

            // Don't write to locked lines — picker would have opened in read-only
            // mode, but if for any reason it didn't, this is the safety net.
            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            if (processed || linkedTo) {
                dbg('handlePickerSelection:skipLocked');
                pendingPickerLineIndex = null;
                return;
            }

            // Empty locId means user cleared the selection in the picker — clear the field.
            var newLoc = payload && payload.locId ? payload.locId : '';
            rec.setCurrentSublistValue({
                sublistId: SUBLIST, fieldId: FIELD.FROM_LOC,
                value: newLoc, ignoreFieldChange: false
            });
            try {
                rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, value: '', ignoreFieldChange: true });
            } catch (clearErr) {}

            pendingPickerLineIndex = null;
            dbg('handlePickerSelection:done', { locId: newLoc || '(cleared)' });
            injectButtonsNow();
        } catch (e) { logErr('handlePickerSelection failed', e, { payload: payload }); }
    }

    // ---------------- Picker ----------------

    function canOpenPicker(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var qtyRequired = getCurrentQtyRequired(rec);
        var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' }) || rec.getValue({ fieldId: 'location' });
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' });

        if (method !== SOURCING_METHOD_TO) { dialog.alert({ title: 'Set Sourcing Method', message: 'Set Sourcing Method to "Transfer Order" first.' }); return false; }
        if (!item) { dialog.alert({ title: 'Item Required', message: 'Select an item first.' }); return false; }
        if (!qtyRequired || qtyRequired <= 0) { dialog.alert({ title: 'Qty Required', message: 'Line has no Qty to Transfer, backordered qty, or line quantity.' }); return false; }
        if (!destLoc) { dialog.alert({ title: 'Destination Location Required', message: 'Set a Location on this line or on the SO header.' }); return false; }
        if (!subsidiary) { dialog.alert({ title: 'Subsidiary Required', message: 'The SO must have a subsidiary.' }); return false; }
        return true;
    }

    function openPicker(rec) {
        try {
            var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
            var qtyRequired = getCurrentQtyRequired(rec);
            var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' }) || rec.getValue({ fieldId: 'location' });
            var subsidiary = rec.getValue({ fieldId: 'subsidiary' });
            var soId = rec.id || '';
            var lineIndex = rec.getCurrentSublistIndex({ sublistId: SUBLIST });

            // Pass the line's current from_location so the picker can pre-select it
            var currentFromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC }) || '';

            // Determine if we should open in read-only mode:
            //   - line is locked (linked TO exists), OR
            //   - page is in view mode
            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            var locked = !!processed || !!linkedTo;
            var isViewMode = (typeof pageMode === 'string' && pageMode === 'view');
            var readOnly = locked || isViewMode;

            pendingPickerLineIndex = lineIndex;

            var params = {
                itemId: item, qtyRequired: qtyRequired,
                destLocationId: destLoc, subsidiaryId: subsidiary,
                soId: soId, lineId: lineIndex
            };
            if (currentFromLoc) params.selectedLocId = currentFromLoc;
            if (readOnly) params.readOnly = 'T';

            var pickerUrl = url.resolveScript({
                scriptId: PICKER_SCRIPT_ID,
                deploymentId: PICKER_DEPLOY_ID,
                params: params
            });

            var w = window.open(pickerUrl, 'bc_inventory_picker',
                'width=820,height=560,resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no');
            if (!w) dialog.alert({ title: 'Popup Blocked', message: 'Allow popups from NetSuite and try again.' });
        } catch (e) { logErr('openPicker failed', e); }
    }

    function getCurrentQtyRequired(rec) {
        var qtyToTransfer = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
        if (qtyToTransfer > 0) return qtyToTransfer;

        var bo = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered' }) || '0');
        if (bo > 0) return bo;

        return parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' }) || '0');
    }

    // ---------------- DOM injection ----------------

    function scheduleInject(delayMs) {
        if (injectTimer) clearTimeout(injectTimer);
        injectTimer = setTimeout(function () { injectTimer = null; injectButtonsNow(); }, delayMs || INJECT_DEBOUNCE_MS);
    }

    function injectButtonsNow() { try { injectButtons(); } catch (e) { logErr('injectButtons failed', e); } }

    function initialInjectWithRetry(idx) {
        injectButtonsNow();
        if (document.getElementById('item_splits')) return;
        if (idx >= INITIAL_RETRY_DELAYS.length) return;
        setTimeout(function () { initialInjectWithRetry(idx + 1); }, INITIAL_RETRY_DELAYS[idx]);
    }

    function injectButtons() {
        var table = document.getElementById('item_splits');
        if (!table) { dbg('injectButtons:noTable'); return; }
        var rec;
        try { rec = currentRecord.get(); } catch (e) { return; }
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return; }
        ensureHeaderCell(table);

        // Walk actual DOM rows under tbody rather than guessing IDs. After
        // Copy Line, NetSuite may not number new rows as item_row_N+1 — it
        // sometimes inserts with non-sequential IDs or re-paints out of order.
        var tbody = table.querySelector('tbody');
        if (!tbody) { dbg('injectButtons:noTbody'); return; }

        // Get all data rows (skip header/totals rows that lack item_row_ id)
        var allRows = tbody.querySelectorAll('tr[id^="item_row_"]');
        dbg('injectButtons:rows', { domRows: allRows.length, recordLines: lineCount });

        // Map each DOM row to a record line index. The DOM order should match
        // the record line order; iterate in document order.
        var currentLine = -1;
        try { currentLine = rec.getCurrentSublistIndex({ sublistId: SUBLIST }); } catch (ignoreCurrent) {}

        for (var i = 0; i < allRows.length; i++) {
            var row = allRows[i];
            var method = '';
            if (i === currentLine) {
                method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
            } else if (i < lineCount) {
                method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            }
            // Button is now informational/edit affordance — show on every
            // TO-method line, locked or not. Popup adapts (read-only or editable).
            var shouldShow = (method === SOURCING_METHOD_TO);

            dbg('injectButtons:line', { idx: i, rowId: row.id, method: method, shouldShow: shouldShow });

            var cell = row.querySelector('td.' + BTN_CELL_CLASS);
            if (!cell) {
                cell = document.createElement('td');
                cell.className = BTN_CELL_CLASS;
                cell.style.padding = '2px 6px';
                cell.style.whiteSpace = 'nowrap';
                row.appendChild(cell);
            }
            if (shouldShow) {
                // Always rewrite the button onclick to reflect the current
                // (possibly shifted) line index. Compare innerHTML cheaply.
                var html = '<button type="button" class="' + BTN_CLASS + '" ' +
                    'style="padding:3px 10px;font-size:11px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;" ' +
                    'onclick="window.bcOpenPicker(' + i + ');return false;">Pick Location</button>';
                if (cell.innerHTML !== html) cell.innerHTML = html;
            } else {
                if (cell.innerHTML) cell.innerHTML = '';
            }
        }
    }

    function ensureHeaderCell(table) {
        var thead = table.querySelector('thead');
        if (!thead) return;
        var hr = thead.querySelector('tr');
        if (!hr || hr.querySelector('th.' + BTN_CELL_CLASS)) return;
        var th = document.createElement('th');
        th.className = BTN_CELL_CLASS;
        th.textContent = 'Pick';
        th.style.padding = '2px 6px';
        hr.appendChild(th);
    }

    function startObserver() {
        var target = document.getElementById('item_splits') || document.body;
        if (!target || observer) return;
        try {
            observer = new MutationObserver(function (mutations) {
                var structural = false;
                for (var i = 0; i < mutations.length; i++) {
                    var m = mutations[i];
                    if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                        var ours = false;
                        for (var j = 0; j < m.addedNodes.length; j++) {
                            var n = m.addedNodes[j];
                            if (n.classList && (n.classList.contains(BTN_CELL_CLASS) || n.classList.contains(BTN_CLASS))) { ours = true; break; }
                        }
                        if (!ours) { structural = true; break; }
                    }
                }
                if (structural) scheduleInject(INJECT_DEBOUNCE_MS);
            });
            observer.observe(target, { childList: true, subtree: true });
        } catch (e) { logErr('observer failed', e); }
    }

    // ---------------- Snapshot helpers ----------------

    function buildLockedSnapshot(rec) {
        var map = {};
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return map; }

        for (var i = 0; i < lineCount; i++) {
            var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i });
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            if (!processed && !linkedTo) continue;

            var id = getLineIdClient(rec, i);
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

    function buildLineIdMapClient(rec) {
        var map = {};
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return map; }
        for (var i = 0; i < lineCount; i++) {
            var id = getLineIdClient(rec, i);
            if (id) map[id] = i;
        }
        return map;
    }

    function getLineIdClient(rec, idx) {
        try {
            var id = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'line', line: idx });
            if (id) return String(id);
        } catch (e) {}
        try {
            var u = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'lineuniquekey', line: idx });
            if (u) return String(u);
        } catch (e) {}
        return null;
    }

    function getActiveLinkedTOLinesClient(rec) {
        var lineCount;
        var toIds = [];
        var lineLabelsByTo = {};
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return []; }

        for (var i = 0; i < lineCount; i++) {
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            if (!linkedTo) continue;

            var key = String(linkedTo);
            if (!lineLabelsByTo[key]) {
                lineLabelsByTo[key] = [];
                toIds.push(linkedTo);
            }
            lineLabelsByTo[key].push('Line ' + (i + 1));
        }
        if (!toIds.length) return [];

        var activeByTo = {};
        var tranIdByTo = {};
        try {
            var s = search.create({
                type: search.Type && search.Type.TRANSFER_ORDER ? search.Type.TRANSFER_ORDER : 'transferorder',
                filters: [['internalid', 'anyof', toIds]],
                columns: [
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'tranid' }),
                    search.createColumn({ name: 'status' })
                ]
            });
            s.run().each(function (r) {
                var id = String(r.getValue({ name: 'internalid' }) || '');
                var status = r.getValue({ name: 'status' }) || r.getText({ name: 'status' }) || '';
                if (ACTIVE_TO_STATUSES[String(status)]) activeByTo[id] = true;
                tranIdByTo[id] = r.getValue({ name: 'tranid' }) || ('TO#' + id);
                return true;
            });
        } catch (e) {
            logErr('active linked TO lookup failed', e);
            return [];
        }

        var blocking = [];
        for (var j = 0; j < toIds.length; j++) {
            var toId = String(toIds[j]);
            if (!activeByTo[toId]) continue;
            blocking.push(lineLabelsByTo[toId].join(', ') + ' (' + (tranIdByTo[toId] || ('TO#' + toId)) + ')');
        }
        return blocking;
    }

    function anyLinkedTOsInRecord(rec) {
        try {
            var lc = rec.getLineCount({ sublistId: SUBLIST });
            for (var i = 0; i < lc; i++) {
                if (rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i })) return true;
            }
        } catch (e) {}
        return false;
    }

    function isLineLocked(rec) {
        try {
            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            return !!processed || !!linkedTo;
        } catch (e) { return false; }
    }

    function hasAny(obj) { for (var k in obj) if (obj.hasOwnProperty(k)) return true; return false; }

    return {
        pageInit: pageInit,
        lineInit: lineInit,
        fieldChanged: fieldChanged,
        postSourcing: postSourcing,
        sublistChanged: sublistChanged,
        validateLine: validateLine,
        saveRecord: saveRecord
    };
});
