/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script (DOM-injected line button)
 *
 * Inline HTML transaction column fields don't render in edit mode on the item
 * sublist (NetSuite limitation). To get a line-level "Pick Location" button
 * working, we inject buttons directly into the sublist DOM and use a
 * MutationObserver to keep them in sync as the user adds/edits/removes lines.
 *
 * Custom list internal IDs (customlist_bc_sourcing_method):
 *   1 = Stock, 2 = PO, 3 = Transfer Order
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

    // CSS class we attach to injected buttons so we can find/replace them
    var BTN_CLASS = 'bc-pick-loc-btn';
    var BTN_CELL_CLASS = 'bc-pick-loc-cell';

    var pendingPickerLineIndex = null;
    var observer = null;
    var injectTimer = null;

    // ---------------- Logging ----------------

    function dbg(title, obj) {
        if (!DEBUG) return;
        try { console.log('[BC SO Sourcing]', title, obj || ''); } catch (e) {}
    }

    function logErr(title, e, extra) {
        try { console.error('[BC SO Sourcing]', title, e, extra || ''); } catch (x) {}
    }

    // ---------------- Entry points ----------------

    function pageInit(context) {
        dbg('pageInit', { mode: context && context.mode });

        // Popup callback
        window.bcPickerCallback = function (payload) {
            dbg('bcPickerCallback', payload);
            handlePickerSelection(payload);
        };

        // Button onclick target
        window.bcOpenPicker = function (lineIndex) {
            dbg('bcOpenPicker:click', { lineIndex: lineIndex });
            try {
                var rec = currentRecord.get();
                rec.selectLine({ sublistId: SUBLIST, line: parseInt(lineIndex, 10) });
                if (canOpenPicker(rec)) {
                    openPicker(rec);
                }
            } catch (e) {
                logErr('bcOpenPicker failed', e);
            }
        };

        // postMessage fallback
        window.addEventListener('message', function (event) {
            if (event && event.data && event.data.source === 'bc_picker') {
                handlePickerSelection(event.data);
            }
        }, false);

        // Initial inject + start observer
        scheduleInject(300);
        startObserver();
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST) return;

        try {
            var rec = context.currentRecord;

            if (isLineLocked(rec)) {
                dbg('fieldChanged:lineLocked:skip', { field: context.fieldId });
                return;
            }

            if (context.fieldId === FIELD.METHOD) {
                handleMethodChange(rec);
                scheduleInject(150); // method change → button needs to appear/disappear
            } else if (context.fieldId === FIELD.QTY_TRANSFER) {
                handleQtyChange(rec);
            }
        } catch (e) {
            logErr('fieldChanged failed', e, { field: context.fieldId });
        }
    }

    function postSourcing(context) {
        // After NetSuite finishes sourcing a field (e.g., item lookup populating
        // defaults), re-inject in case the sublist redrew.
        if (context.sublistId === SUBLIST) {
            scheduleInject(150);
        }
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
            var qtyTransfer = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');

            if (!item) {
                dialog.alert({ title: 'Item Required', message: 'Please select an item before choosing TO sourcing.' });
                return false;
            }
            if (!fromLoc) {
                dialog.alert({ title: 'Source Location Required', message: 'Click the Pick Location button on this line to choose a source location.' });
                return false;
            }
            if (!qtyTransfer || qtyTransfer <= 0) {
                dialog.alert({ title: 'Qty to Transfer Required', message: 'Qty to Transfer must be greater than zero for TO sourcing.' });
                return false;
            }
            return true;
        } catch (e) {
            logErr('validateLine failed', e);
            return true;
        }
    }

    // After a line is added, removed, or the user moves to a different line,
    // re-inject so the buttons stay in sync.
    function postSourcingFinished(ctx) { scheduleInject(100); }
    function sublistChanged(context) {
        if (context && context.sublistId === SUBLIST) {
            scheduleInject(100);
        }
    }
    function lineInit(context) {
        if (context && context.sublistId === SUBLIST) {
            scheduleInject(100);
        }
    }

    // ---------------- Handlers ----------------

    function handleMethodChange(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        dbg('handleMethodChange', { method: method });

        if (method === SOURCING_METHOD_TO) {
            var qtyTransfer = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER });
            if (!qtyTransfer) {
                var lineQty = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' });
                if (lineQty) {
                    rec.setCurrentSublistValue({
                        sublistId: SUBLIST,
                        fieldId: FIELD.QTY_TRANSFER,
                        value: lineQty,
                        ignoreFieldChange: true
                    });
                }
            }
        } else {
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: '', ignoreFieldChange: true });
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
        }
    }

    function handleQtyChange(rec) {
        var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
        if (qty < 0) {
            dialog.alert({ title: 'Invalid Quantity', message: 'Qty to Transfer cannot be negative.' });
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
        }
    }

    function handlePickerSelection(payload) {
        try {
            var rec = currentRecord.get();
            if (pendingPickerLineIndex !== null) {
                rec.selectLine({ sublistId: SUBLIST, line: pendingPickerLineIndex });
            }
            rec.setCurrentSublistValue({
                sublistId: SUBLIST,
                fieldId: FIELD.FROM_LOC,
                value: payload.locId,
                ignoreFieldChange: false
            });
            pendingPickerLineIndex = null;
            dbg('handlePickerSelection:done', { locId: payload.locId });
            scheduleInject(100);
        } catch (e) {
            logErr('handlePickerSelection failed', e, { payload: payload });
        }
    }

    // ---------------- Picker invocation ----------------

    function canOpenPicker(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
        var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' })
                   || rec.getValue({ fieldId: 'location' });
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' });

        if (method !== SOURCING_METHOD_TO) {
            dialog.alert({ title: 'Set Sourcing Method', message: 'Change Sourcing Method on this line to "Transfer Order" first.' });
            return false;
        }
        if (!item) {
            dialog.alert({ title: 'Item Required', message: 'Select an item before choosing a source location.' });
            return false;
        }
        if (!qty || qty <= 0) {
            dialog.alert({ title: 'Qty Required', message: 'Enter Qty to Transfer before opening the picker.' });
            return false;
        }
        if (!destLoc) {
            dialog.alert({ title: 'Destination Location Required', message: 'Set the destination Location on the SO line (or header) before sourcing from another location.' });
            return false;
        }
        if (!subsidiary) {
            dialog.alert({ title: 'Subsidiary Required', message: 'The SO must have a subsidiary before opening the picker.' });
            return false;
        }
        return true;
    }

    function openPicker(rec) {
        try {
            var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
            var qty = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER });
            var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' })
                       || rec.getValue({ fieldId: 'location' });
            var subsidiary = rec.getValue({ fieldId: 'subsidiary' });
            var soId = rec.id || '';
            var lineIndex = rec.getCurrentSublistIndex({ sublistId: SUBLIST });

            pendingPickerLineIndex = lineIndex;

            var pickerUrl = url.resolveScript({
                scriptId: PICKER_SCRIPT_ID,
                deploymentId: PICKER_DEPLOY_ID,
                params: {
                    itemId: item,
                    qtyRequired: qty,
                    destLocationId: destLoc,
                    subsidiaryId: subsidiary,
                    soId: soId,
                    lineId: lineIndex
                }
            });

            var w = window.open(pickerUrl, 'bc_inventory_picker',
                'width=820,height=560,resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no');

            if (!w) {
                dialog.alert({
                    title: 'Popup Blocked',
                    message: 'Your browser blocked the inventory picker popup. Allow popups from NetSuite and try again.'
                });
            }
        } catch (e) {
            logErr('openPicker failed', e);
        }
    }

    // ---------------- DOM injection ----------------

    /**
     * Debounce wrapper around injectButtons. NetSuite redraws the sublist
     * frequently; we don't want to thrash.
     */
    function scheduleInject(delayMs) {
        if (injectTimer) clearTimeout(injectTimer);
        injectTimer = setTimeout(function () {
            injectTimer = null;
            try { injectButtons(); } catch (e) { logErr('injectButtons failed', e); }
        }, delayMs || 200);
    }

    /**
     * Walk the visible item sublist rows and ensure each row has a button
     * (when method=TO) or no button (otherwise).
     */
    function injectButtons() {
        // NetSuite renders the item sublist as a table with id="item_splits"
        // and row IDs like "item_row_1", "item_row_2", ...
        var table = document.getElementById('item_splits');
        if (!table) {
            dbg('injectButtons:noTable');
            return;
        }

        var rec;
        try { rec = currentRecord.get(); } catch (e) { return; }

        // The item sublist column for method is identified by the field machine name.
        // Native NetSuite gives column cells a class like "input_columnN" or with the
        // field id in the cell. Easiest reliable path: read line values via the
        // record API and locate rows by index.
        var lineCount;
        try {
            lineCount = rec.getLineCount({ sublistId: SUBLIST });
        } catch (e) {
            return;
        }

        // Find or create a header cell label for our column (visual nicety)
        ensureHeaderCell(table);

        for (var i = 0; i < lineCount; i++) {
            var row = document.getElementById('item_row_' + (i + 1));
            if (!row) continue;

            var method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i });
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            var locked = !!processed || !!linkedTo;

            var shouldShow = (method === SOURCING_METHOD_TO) && !locked;

            // Find or create our cell at the end of the row
            var cell = row.querySelector('td.' + BTN_CELL_CLASS);
            if (!cell) {
                cell = document.createElement('td');
                cell.className = BTN_CELL_CLASS;
                cell.style.padding = '2px 6px';
                cell.style.whiteSpace = 'nowrap';
                row.appendChild(cell);
            }

            if (shouldShow) {
                cell.innerHTML = '<button type="button" class="' + BTN_CLASS + '" ' +
                    'style="padding:3px 10px;font-size:11px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;" ' +
                    'onclick="window.bcOpenPicker(' + i + ');return false;">Pick Location</button>';
            } else {
                cell.innerHTML = '';
            }
        }

        dbg('injectButtons:done', { lineCount: lineCount });
    }

    function ensureHeaderCell(table) {
        var thead = table.querySelector('thead');
        if (!thead) return;
        var headerRow = thead.querySelector('tr');
        if (!headerRow) return;
        if (headerRow.querySelector('th.' + BTN_CELL_CLASS)) return;

        var th = document.createElement('th');
        th.className = BTN_CELL_CLASS;
        th.textContent = 'Pick';
        th.style.padding = '2px 6px';
        headerRow.appendChild(th);
    }

    /**
     * MutationObserver: NetSuite redraws the sublist table whenever the user
     * adds/edits/removes a line. Re-inject buttons after each redraw.
     */
    function startObserver() {
        var target = document.getElementById('item_splits') ||
                     document.getElementById('tbl_item') ||
                     document.body;

        if (!target || observer) return;

        try {
            observer = new MutationObserver(function (mutations) {
                // Only re-inject if structural changes happened (rows added/removed)
                var structural = mutations.some(function (m) {
                    return m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length);
                });
                if (structural) scheduleInject(150);
            });
            observer.observe(target, { childList: true, subtree: true });
            dbg('observer:started');
        } catch (e) {
            logErr('observer:failed', e);
        }
    }

    // ---------------- Helpers ----------------

    function isLineLocked(rec) {
        try {
            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            return !!processed || !!linkedTo;
        } catch (e) {
            return false;
        }
    }

    return {
        pageInit: pageInit,
        lineInit: lineInit,
        fieldChanged: fieldChanged,
        postSourcing: postSourcing,
        sublistChanged: sublistChanged,
        validateLine: validateLine
    };
});