/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script
 *
 * Wires up the Sourcing Method / Source From Location / Qty to Transfer fields
 * on Sales Order lines, and opens the BC Inventory Picker Suitelet when the
 * user needs to select a source location for Transfer Order sourcing.
 *
 * Custom list internal IDs (customlist_bc_sourcing_method):
 *   1 = Stock
 *   2 = Purchase Order (PO)
 *   3 = Transfer Order (TO)
 */
define(['N/url', 'N/currentRecord', 'N/ui/dialog'], function (url, currentRecord, dialog) {

    var SOURCING_METHOD_TO = '3';   // Transfer Order
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

    // Track which line is awaiting a picker callback so we write to the right line
    var pendingPickerLineIndex = null;

    function pageInit(context) {
        // Expose a callback on the page so the Suitelet popup can call us directly
        window.bcPickerCallback = function (payload) {
            handlePickerSelection(payload);
        };

        // Listen for postMessage as a fallback transport
        window.addEventListener('message', function (event) {
            if (event && event.data && event.data.source === 'bc_picker') {
                handlePickerSelection(event.data);
            }
        }, false);
    }

    /**
     * Fired when any line field changes.
     * - Method changed: enable/disable downstream fields, optionally open picker
     * - Qty changed: light validation
     */
    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST) return;

        var rec = context.currentRecord;

        // Don't react to changes on a locked (already processed) line
        if (isLineLocked(rec)) {
            return;
        }

        if (context.fieldId === FIELD.METHOD) {
            handleMethodChange(rec);
        } else if (context.fieldId === FIELD.QTY_TRANSFER) {
            handleQtyChange(rec);
        }
    }

    /**
     * Validation gate before the line is committed (Add / OK button).
     * Blocks invalid TO-sourced lines from being added to the sublist.
     */
    function validateLine(context) {
        if (context.sublistId !== SUBLIST) return true;

        var rec = context.currentRecord;
        var method = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD });

        // Only enforce when method = TO
        if (String(method) !== SOURCING_METHOD_TO) return true;

        // Skip lines that have already been processed (Admin editing existing)
        if (isLineLocked(rec)) return true;

        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var fromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC });
        var qtyTransfer = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');

        if (!item) {
            dialog.alert({ title: 'Item Required', message: 'Please select an item before choosing TO sourcing.' });
            return false;
        }
        if (!fromLoc) {
            dialog.alert({ title: 'Source Location Required', message: 'A Source From Location must be selected for Transfer Order sourcing. Click in the Source From Location field to open the inventory picker.' });
            return false;
        }
        if (!qtyTransfer || qtyTransfer <= 0) {
            dialog.alert({ title: 'Qty to Transfer Required', message: 'Qty to Transfer must be greater than zero for TO sourcing.' });
            return false;
        }

        return true;
    }

    // ---------------- Handlers ----------------

    function handleMethodChange(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');

        if (method === SOURCING_METHOD_TO) {
            // Switching TO: if qty hasn't been entered yet, default it to the line quantity
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

            // Auto-open picker if everything is ready
            if (canOpenPicker(rec)) {
                openPicker(rec);
            }
        } else {
            // Method changed away from TO: clear downstream fields
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: '', ignoreFieldChange: true });
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
        }
    }

    function handleQtyChange(rec) {
        var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
        if (qty < 0) {
            dialog.alert({ title: 'Invalid Quantity', message: 'Qty to Transfer cannot be negative.' });
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
            return;
        }

        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        var fromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC });

        // If user changed qty after picking a location, re-open picker so they can re-validate availability
        if (method === SOURCING_METHOD_TO && fromLoc && qty > 0) {
            // Don't force re-pick; just leave it. Re-check happens in UE / engine.
        }
    }

    function handlePickerSelection(payload) {
        try {
            var rec = currentRecord.get();
            // If we have a pending line index, switch to it before writing
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
        } catch (e) {
            console.error('BC picker callback failed:', e);
        }
    }

    // ---------------- Picker invocation ----------------

    function canOpenPicker(rec) {
        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
        var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' })
                   || rec.getValue({ fieldId: 'location' });
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' });

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
    }

    // ---------------- Helpers ----------------

    function isLineLocked(rec) {
        // A line is "locked" if processed flag is set or a Linked TO exists.
        // Non-Admin users can't see/edit these via field-level access, but Admins can.
        var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
        var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
        return !!processed || !!linkedTo;
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged,
        validateLine: validateLine
    };
});
