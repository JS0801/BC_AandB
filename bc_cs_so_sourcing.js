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
define(['N/url', 'N/currentRecord', 'N/ui/dialog'], function (url, currentRecord, dialog) {

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
    var pendingPickerLineIndex = null;
    var observer = null;
    var injectTimer = null;

    // ---------------- Logging ----------------

    function dbg(t, o) { if (DEBUG) try { console.log('[BC SO Sourcing]', t, o || ''); } catch (e) {} }
    function logErr(t, e, x) { try { console.error('[BC SO Sourcing]', t, e, x || ''); } catch (z) {} }

    // ---------------- Entry points ----------------

    function pageInit(context) {
        dbg('pageInit', { mode: context && context.mode });

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
                r.selectLine({ sublistId: SUBLIST, line: parseInt(lineIndex, 10) });
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
        if (context && context.sublistId === SUBLIST) scheduleInject(INJECT_DEBOUNCE_MS);
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
            var rec = context.currentRecord;
            var method = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD });
            if (String(method) !== SOURCING_METHOD_TO) return true;
            if (isLineLocked(rec)) return true;

            var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
            var fromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC });

            if (!item) { dialog.alert({ title: 'Item Required', message: 'Please select an item before choosing TO sourcing.' }); return false; }
            if (!fromLoc) { dialog.alert({ title: 'Source Location Required', message: 'Click Pick Location to select a source.' }); return false; }
            return true;
        } catch (e) { logErr('validateLine failed', e); return true; }
    }

    /**
     * saveRecord runs before any submit. Return false to block save.
     * This is the client-side mirror of the UE beforeSubmit lock checks.
     */
    function saveRecord(context) {
        try {
            var rec = context.currentRecord;

            // 1. Header subsidiary / location change check
            if (originalHeader) {
                var anyLinked = anyLinkedTOsInRecord(rec);
                if (anyLinked) {
                    var newSub = rec.getValue({ fieldId: 'subsidiary' });
                    if (String(originalHeader.subsidiary || '') !== String(newSub || '')) {
                        dialog.alert({ title: 'Cannot Change Subsidiary', message: 'This SO has linked Transfer Orders. Cancel and clear the linked TOs before changing Subsidiary.' });
                        return false;
                    }
                    var newLoc = rec.getValue({ fieldId: 'location' });
                    if (String(originalHeader.location || '') !== String(newLoc || '')) {
                        dialog.alert({ title: 'Cannot Change Header Location', message: 'This SO has linked Transfer Orders. Cancel and clear the linked TOs before changing the header Location.' });
                        return false;
                    }
                }

                // 2. Close/cancel transition check
                var newStatus = rec.getValue({ fieldId: 'orderstatus' }) || rec.getValue({ fieldId: 'status' });
                if (String(originalHeader.status || '') !== String(newStatus || '') && CLOSED_STATUSES[newStatus]) {
                    if (anyLinked) {
                        dialog.alert({ title: 'Cannot Close/Cancel SO', message: 'This SO has lines with linked Transfer Orders. Cancel or operationally reverse those TOs before closing this SO.' });
                        return false;
                    }
                }
            }

            // 3. Locked-line restrictions
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
                rec.selectLine({ sublistId: SUBLIST, line: pendingPickerLineIndex });
            }
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: payload.locId, ignoreFieldChange: false });
            pendingPickerLineIndex = null;
            injectButtonsNow();
        } catch (e) { logErr('handlePickerSelection failed', e, { payload: payload }); }
    }

    // ---------------- Picker ----------------

    function canOpenPicker(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var bo = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered' }) || '0');
        var lineQty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' }) || '0');
        var qtyRequired = bo > 0 ? bo : lineQty;
        var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' }) || rec.getValue({ fieldId: 'location' });
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' });

        if (method !== SOURCING_METHOD_TO) { dialog.alert({ title: 'Set Sourcing Method', message: 'Set Sourcing Method to "Transfer Order" first.' }); return false; }
        if (!item) { dialog.alert({ title: 'Item Required', message: 'Select an item first.' }); return false; }
        if (!qtyRequired || qtyRequired <= 0) { dialog.alert({ title: 'Qty Required', message: 'Line has no backordered qty or quantity to transfer.' }); return false; }
        if (!destLoc) { dialog.alert({ title: 'Destination Location Required', message: 'Set a Location on this line or on the SO header.' }); return false; }
        if (!subsidiary) { dialog.alert({ title: 'Subsidiary Required', message: 'The SO must have a subsidiary.' }); return false; }
        return true;
    }

    function openPicker(rec) {
        try {
            var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
            var bo = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered' }) || '0');
            var lineQty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' }) || '0');
            var qtyRequired = bo > 0 ? bo : lineQty;
            var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' }) || rec.getValue({ fieldId: 'location' });
            var subsidiary = rec.getValue({ fieldId: 'subsidiary' });
            var soId = rec.id || '';
            var lineIndex = rec.getCurrentSublistIndex({ sublistId: SUBLIST });

            pendingPickerLineIndex = lineIndex;

            var pickerUrl = url.resolveScript({
                scriptId: PICKER_SCRIPT_ID,
                deploymentId: PICKER_DEPLOY_ID,
                params: { itemId: item, qtyRequired: qtyRequired, destLocationId: destLoc, subsidiaryId: subsidiary, soId: soId, lineId: lineIndex }
            });

            var w = window.open(pickerUrl, 'bc_inventory_picker',
                'width=820,height=560,resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no');
            if (!w) dialog.alert({ title: 'Popup Blocked', message: 'Allow popups from NetSuite and try again.' });
        } catch (e) { logErr('openPicker failed', e); }
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
        if (!table) return;
        var rec;
        try { rec = currentRecord.get(); } catch (e) { return; }
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return; }
        ensureHeaderCell(table);

        for (var i = 0; i < lineCount; i++) {
            var row = document.getElementById('item_row_' + (i + 1));
            if (!row) continue;
            var method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i });
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            var locked = !!processed || !!linkedTo;
            var shouldShow = (method === SOURCING_METHOD_TO) && !locked;

            var cell = row.querySelector('td.' + BTN_CELL_CLASS);
            if (!cell) {
                cell = document.createElement('td');
                cell.className = BTN_CELL_CLASS;
                cell.style.padding = '2px 6px';
                cell.style.whiteSpace = 'nowrap';
                row.appendChild(cell);
            }
            if (shouldShow) {
                if (!cell.querySelector('button.' + BTN_CLASS)) {
                    cell.innerHTML = '<button type="button" class="' + BTN_CLASS + '" ' +
                        'style="padding:3px 10px;font-size:11px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;" ' +
                        'onclick="window.bcOpenPicker(' + i + ');return false;">Pick Location</button>';
                } else {
                    cell.querySelector('button.' + BTN_CLASS).setAttribute('onclick', 'window.bcOpenPicker(' + i + ');return false;');
                }
            } else if (cell.innerHTML) {
                cell.innerHTML = '';
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
