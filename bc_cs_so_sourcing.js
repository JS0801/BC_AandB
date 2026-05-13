/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script (button-driven picker)
 *
 * Picker no longer auto-opens on method change. Instead, a "Pick Location"
 * button renders in the custcol_bc_pick_btn inline-HTML column on lines where
 * Sourcing Method = Transfer Order. User clicks the button to open the picker.
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
        ERROR:        'custcol_bc_sourcing_error',
        PICK_BTN:     'custcol_bc_pick_btn'
    };

    var PICKER_SCRIPT_ID = 'customscript_bc_sl_inventory_picker';
    var PICKER_DEPLOY_ID = 'customdeploy_bc_sl_inventory_picker';

    var pendingPickerLineIndex = null;

    // ---------------- Logging ----------------

    function dbg(title, obj) {
        if (!DEBUG) return;
        try { console.log('[BC SO Sourcing]', title, obj || ''); } catch (e) {}
    }

    function err(title, e, extra) {
        try { console.error('[BC SO Sourcing]', title, e, extra || ''); } catch (x) {}
    }

    // ---------------- Entry points ----------------

    function pageInit(context) {
        dbg('pageInit', { mode: context && context.mode });

        // Callback the Suitelet popup invokes directly
        window.bcPickerCallback = function (payload) {
            dbg('bcPickerCallback', payload);
            handlePickerSelection(payload);
        };

        // Global function the line button calls
        window.bcOpenPicker = function (lineIndex) {
            dbg('bcOpenPicker:click', { lineIndex: lineIndex });
            try {
                var rec = currentRecord.get();
                rec.selectLine({ sublistId: SUBLIST, line: parseInt(lineIndex, 10) });
                if (canOpenPicker(rec)) {
                    openPicker(rec);
                }
            } catch (e) {
                err('bcOpenPicker failed', e);
            }
        };

        // postMessage fallback
        window.addEventListener('message', function (event) {
            if (event && event.data && event.data.source === 'bc_picker') {
                handlePickerSelection(event.data);
            }
        }, false);
    }

    function lineInit(context) {
        if (context.sublistId !== SUBLIST) return;
        try {
            renderPickButton(context.currentRecord);
        } catch (e) {
            err('lineInit failed', e);
        }
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
                renderPickButton(rec);
            } else if (context.fieldId === FIELD.QTY_TRANSFER) {
                handleQtyChange(rec);
            } else if (context.fieldId === 'item' || context.fieldId === 'quantity') {
                renderPickButton(rec);
            }
        } catch (e) {
            err('fieldChanged failed', e, { field: context.fieldId });
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
            err('validateLine failed', e);
            return true;
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
            // No auto-open. User clicks the Pick Location button on the line.
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
        } catch (e) {
            err('handlePickerSelection failed', e, { payload: payload });
        }
    }

    // ---------------- Picker invocation ----------------

    function canOpenPicker(rec) {
        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
        var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' })
                   || rec.getValue({ fieldId: 'location' });
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' });
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');

        if (method !== SOURCING_METHOD_TO) {
            dialog.alert({ title: 'Set Sourcing Method', message: 'Change Sourcing Method to "Transfer Order" before picking a source location.' });
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
            err('openPicker failed', e);
        }
    }

    // ---------------- Button rendering ----------------

    function renderPickButton(rec) {
        try {
            var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
            var lineIndex = rec.getCurrentSublistIndex({ sublistId: SUBLIST });

            var html = '';
            if (method === SOURCING_METHOD_TO && !isLineLocked(rec)) {
                html = '<button type="button" ' +
                       'style="padding:3px 10px;font-size:12px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;" ' +
                       'onclick="window.bcOpenPicker(' + lineIndex + ')">Pick Location</button>';
            }

            rec.setCurrentSublistValue({
                sublistId: SUBLIST,
                fieldId: FIELD.PICK_BTN,
                value: html,
                ignoreFieldChange: true
            });
        } catch (e) {
            err('renderPickButton failed', e);
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
        validateLine: validateLine
    };
});