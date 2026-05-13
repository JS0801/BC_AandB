/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script (with detailed logs)
 */
define(['N/url', 'N/currentRecord', 'N/ui/dialog', 'N/log'], function (url, currentRecord, dialog, log) {

    var DEBUG = true; // <-- turn off in production once stable

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

    // ---------------- Logging helpers ----------------

    function safeStringify(obj) {
        try { return JSON.stringify(obj); } catch (e) { return String(obj); }
    }

    function getLineSnapshot(rec) {
        // Capture context that helps debug “wrong line”, “wrong values”, “can’t open picker”, etc.
        var snap = {};
        try {
            snap.soId = rec.id || '';
            snap.subsidiary = rec.getValue({ fieldId: 'subsidiary' }) || '';
            snap.headerLocation = rec.getValue({ fieldId: 'location' }) || '';

            // Current line details (may throw if not on a line yet)
            snap.lineIndex = rec.getCurrentSublistIndex({ sublistId: SUBLIST });
            snap.item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' }) || '';
            snap.method = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '';
            snap.qtyLine = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' }) || '';
            snap.qtyTransfer = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '';
            snap.fromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC }) || '';
            snap.destLocLine = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' }) || '';
            snap.processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED }) || '';
            snap.linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO }) || '';
        } catch (e) {
            snap.snapshotError = e && e.message ? e.message : String(e);
        }

        snap.pendingPickerLineIndex = pendingPickerLineIndex;
        return snap;
    }

    function debugLog(title, detailsObj) {
        if (!DEBUG) return;

        var msg = title + (detailsObj ? (' | ' + safeStringify(detailsObj)) : '');

        // Browser console
        try { console.log('[BC SO Sourcing]', msg); } catch (e) {}

        // NetSuite log module (if available)
        try {
            if (log && typeof log.debug === 'function') {
                log.debug({ title: title, details: detailsObj ? safeStringify(detailsObj) : '' });
            }
        } catch (e2) {}
    }

    function errorLog(title, err, extraObj) {
        var payload = {
            error: err && err.name ? (err.name + ': ' + err.message) : String(err),
            stack: err && err.stack ? String(err.stack) : '',
            extra: extraObj || {}
        };

        // Browser console
        try { console.error('[BC SO Sourcing]', title, payload); } catch (e) {}

        // NetSuite log module
        try {
            if (log && typeof log.error === 'function') {
                log.error({ title: title, details: safeStringify(payload) });
            }
        } catch (e2) {}
    }

    // ---------------- Entry points ----------------

    function pageInit(context) {
        debugLog('pageInit:start', { contextType: context && context.mode, hasWindow: !!window });

        // Expose a callback on the page so the Suitelet popup can call us directly
        window.bcPickerCallback = function (payload) {
            debugLog('bcPickerCallback:called', { payload: payload });
            handlePickerSelection(payload);
        };

        // Listen for postMessage as a fallback transport
        window.addEventListener('message', function (event) {
            try {
                debugLog('postMessage:received', {
                    origin: event && event.origin,
                    data: event && event.data
                });

                if (event && event.data && event.data.source === 'bc_picker') {
                    handlePickerSelection(event.data);
                }
            } catch (e) {
                errorLog('postMessage handler failed', e);
            }
        }, false);

        debugLog('pageInit:done', getLineSnapshot(currentRecord.get()));
    }

    /**
     * Fired when any line field changes.
     */
    function fieldChanged(context) {
        try {
            if (context.sublistId !== SUBLIST) return;

            var rec = context.currentRecord;
            debugLog('fieldChanged', {
                fieldId: context.fieldId,
                line: context.line,
                snapshot: getLineSnapshot(rec)
            });

            // Don't react to changes on a locked (already processed) line
            if (isLineLocked(rec)) {
                debugLog('fieldChanged:lineLocked:skip', getLineSnapshot(rec));
                return;
            }

            if (context.fieldId === FIELD.METHOD) {
                handleMethodChange(rec);
            } else if (context.fieldId === FIELD.QTY_TRANSFER) {
                handleQtyChange(rec);
            }
        } catch (e) {
            errorLog('fieldChanged failed', e, { context: context });
        }
    }

    /**
     * Validation gate before the line is committed (Add / OK button).
     */
    function validateLine(context) {
        try {
            if (context.sublistId !== SUBLIST) return true;

            var rec = context.currentRecord;
            var method = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD });

            debugLog('validateLine:start', { method: method, snapshot: getLineSnapshot(rec) });

            // Only enforce when method = TO
            if (String(method) !== SOURCING_METHOD_TO) {
                debugLog('validateLine:notTO:allow', { method: method });
                return true;
            }

            // Skip lines that have already been processed (Admin editing existing)
            if (isLineLocked(rec)) {
                debugLog('validateLine:lineLocked:allow', getLineSnapshot(rec));
                return true;
            }

            var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
            var fromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC });
            var qtyTransfer = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');

            debugLog('validateLine:values', { item: item, fromLoc: fromLoc, qtyTransfer: qtyTransfer });

            if (!item) {
                dialog.alert({ title: 'Item Required', message: 'Please select an item before choosing TO sourcing.' });
                debugLog('validateLine:block:itemMissing', getLineSnapshot(rec));
                return false;
            }
            if (!fromLoc) {
                dialog.alert({ title: 'Source Location Required', message: 'A Source From Location must be selected for Transfer Order sourcing. Click in the Source From Location field to open the inventory picker.' });
                debugLog('validateLine:block:fromLocMissing', getLineSnapshot(rec));
                return false;
            }
            if (!qtyTransfer || qtyTransfer <= 0) {
                dialog.alert({ title: 'Qty to Transfer Required', message: 'Qty to Transfer must be greater than zero for TO sourcing.' });
                debugLog('validateLine:block:qtyInvalid', getLineSnapshot(rec));
                return false;
            }

            debugLog('validateLine:pass', getLineSnapshot(rec));
            return true;
        } catch (e) {
            errorLog('validateLine failed', e, { context: context });
            // Fail open to avoid blocking users if logging causes issues
            return true;
        }
    }

    // ---------------- Handlers ----------------

    function handleMethodChange(rec) {
        try {
            var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
            debugLog('handleMethodChange:start', { method: method, snapshot: getLineSnapshot(rec) });

            if (method === SOURCING_METHOD_TO) {
                // Switching TO: if qty hasn't been entered yet, default it to the line quantity
                var qtyTransfer = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER });
                if (!qtyTransfer) {
                    var lineQty = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' });
                    debugLog('handleMethodChange:defaultQtyCheck', { qtyTransfer: qtyTransfer, lineQty: lineQty });

                    if (lineQty) {
                        rec.setCurrentSublistValue({
                            sublistId: SUBLIST,
                            fieldId: FIELD.QTY_TRANSFER,
                            value: lineQty,
                            ignoreFieldChange: true
                        });
                        debugLog('handleMethodChange:defaultQtySet', getLineSnapshot(rec));
                    }
                }

                // Auto-open picker if everything is ready
                var ready = canOpenPicker(rec);
                debugLog('handleMethodChange:canOpenPicker', { ready: ready, snapshot: getLineSnapshot(rec) });

                if (ready) {
                    openPicker(rec);
                }
            } else {
                // Method changed away from TO: clear downstream fields
                debugLog('handleMethodChange:clearDownstream', getLineSnapshot(rec));
                rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: '', ignoreFieldChange: true });
                rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
                debugLog('handleMethodChange:cleared', getLineSnapshot(rec));
            }
        } catch (e) {
            errorLog('handleMethodChange failed', e, getLineSnapshot(rec));
        }
    }

    function handleQtyChange(rec) {
        try {
            var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
            debugLog('handleQtyChange:start', { qty: qty, snapshot: getLineSnapshot(rec) });

            if (qty < 0) {
                dialog.alert({ title: 'Invalid Quantity', message: 'Qty to Transfer cannot be negative.' });
                rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
                debugLog('handleQtyChange:clearedNegative', getLineSnapshot(rec));
                return;
            }

            var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
            var fromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC });

            debugLog('handleQtyChange:context', { method: method, fromLoc: fromLoc, qty: qty });

            // If user changed qty after picking a location, we currently do not force re-pick.
            if (method === SOURCING_METHOD_TO && fromLoc && qty > 0) {
                debugLog('handleQtyChange:qtyChangedAfterPick:note', { note: 'No forced repick; validation handled downstream.' });
            }
        } catch (e) {
            errorLog('handleQtyChange failed', e, getLineSnapshot(rec));
        }
    }

    function handlePickerSelection(payload) {
        try {
            debugLog('handlePickerSelection:start', { payload: payload, pendingPickerLineIndex: pendingPickerLineIndex });

            var rec = currentRecord.get();

            // If we have a pending line index, switch to it before writing
            if (pendingPickerLineIndex !== null) {
                debugLog('handlePickerSelection:selectLine', { line: pendingPickerLineIndex });
                rec.selectLine({ sublistId: SUBLIST, line: pendingPickerLineIndex });
            }

            debugLog('handlePickerSelection:beforeSet', getLineSnapshot(rec));

            rec.setCurrentSublistValue({
                sublistId: SUBLIST,
                fieldId: FIELD.FROM_LOC,
                value: payload.locId,
                ignoreFieldChange: false
            });

            debugLog('handlePickerSelection:afterSet', getLineSnapshot(rec));

            pendingPickerLineIndex = null;
            debugLog('handlePickerSelection:done', { pendingPickerLineIndex: pendingPickerLineIndex });
        } catch (e) {
            errorLog('BC picker callback failed', e, { payload: payload, pendingPickerLineIndex: pendingPickerLineIndex });
        }
    }

    // ---------------- Picker invocation ----------------

    function canOpenPicker(rec) {
        try {
            var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
            var qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER }) || '0');
            var destLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' })
                       || rec.getValue({ fieldId: 'location' });
            var subsidiary = rec.getValue({ fieldId: 'subsidiary' });

            debugLog('canOpenPicker:check', { item: item, qty: qty, destLoc: destLoc, subsidiary: subsidiary });

            if (!item) {
                dialog.alert({ title: 'Item Required', message: 'Select an item before choosing a source location.' });
                debugLog('canOpenPicker:false:itemMissing', getLineSnapshot(rec));
                return false;
            }
            if (!qty || qty <= 0) {
                dialog.alert({ title: 'Qty Required', message: 'Enter Qty to Transfer before opening the picker.' });
                debugLog('canOpenPicker:false:qtyInvalid', getLineSnapshot(rec));
                return false;
            }
            if (!destLoc) {
                dialog.alert({ title: 'Destination Location Required', message: 'Set the destination Location on the SO line (or header) before sourcing from another location.' });
                debugLog('canOpenPicker:false:destMissing', getLineSnapshot(rec));
                return false;
            }
            if (!subsidiary) {
                dialog.alert({ title: 'Subsidiary Required', message: 'The SO must have a subsidiary before opening the picker.' });
                debugLog('canOpenPicker:false:subsMissing', getLineSnapshot(rec));
                return false;
            }
            return true;
        } catch (e) {
            errorLog('canOpenPicker failed', e, getLineSnapshot(rec));
            return false;
        }
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

            var params = {
                itemId: item,
                qtyRequired: qty,
                destLocationId: destLoc,
                subsidiaryId: subsidiary,
                soId: soId,
                lineId: lineIndex
            };

            debugLog('openPicker:start', { pickerScript: PICKER_SCRIPT_ID, pickerDeploy: PICKER_DEPLOY_ID, params: params });

            var pickerUrl = url.resolveScript({
                scriptId: PICKER_SCRIPT_ID,
                deploymentId: PICKER_DEPLOY_ID,
                params: params
            });

            debugLog('openPicker:url', { url: pickerUrl });

            var w = window.open(
                pickerUrl,
                'bc_inventory_picker',
                'width=820,height=560,resizable=yes,scrollbars=yes,status=no,toolbar=no,menubar=no,location=no'
            );

            debugLog('openPicker:windowOpenResult', { opened: !!w });

            if (!w) {
                dialog.alert({
                    title: 'Popup Blocked',
                    message: 'Your browser blocked the inventory picker popup. Allow popups from NetSuite and try again.'
                });
                debugLog('openPicker:popupBlocked', getLineSnapshot(rec));
            }
        } catch (e) {
            errorLog('openPicker failed', e, getLineSnapshot(rec));
        }
    }

    // ---------------- Helpers ----------------

    function isLineLocked(rec) {
        try {
            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            var locked = !!processed || !!linkedTo;

            if (DEBUG) {
                debugLog('isLineLocked', { processed: processed, linkedTo: linkedTo, locked: locked });
            }

            return locked;
        } catch (e) {
            errorLog('isLineLocked failed', e);
            return false;
        }
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged,
        validateLine: validateLine
    };
});