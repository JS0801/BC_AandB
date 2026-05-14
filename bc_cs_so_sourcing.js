/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script (DOM-injected line button, fast + decoupled)
 *
 * Picker inputs derived from native SO fields, NOT from custom fields:
 *   - Qty Required  = line backordered qty, fallback to line quantity
 *   - Destination   = line location, fallback to header location
 *
 * The custom Qty to Transfer and Source From Location fields are still written
 * to (so the engine and audit trail have them), but the picker no longer
 * depends on them as inputs.
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

    // Tuning
    var INJECT_DEBOUNCE_MS = 30;     // was 150–300, dramatically tighter
    var INITIAL_INJECT_DELAY = 0;    // try synchronously first
    var INITIAL_RETRY_DELAYS = [50, 150, 400, 1000]; // backoff if table not ready

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

        window.bcPickerCallback = function (payload) {
            dbg('bcPickerCallback', payload);
            handlePickerSelection(payload);
        };

        window.bcOpenPicker = function (lineIndex) {
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

        window.addEventListener('message', function (event) {
            if (event && event.data && event.data.source === 'bc_picker') {
                handlePickerSelection(event.data);
            }
        }, false);

        // Try injecting immediately; if table isn't in DOM yet, retry with backoff
        initialInjectWithRetry(0);
        startObserver();
    }

    function lineInit(context) {
        if (context && context.sublistId === SUBLIST) {
            scheduleInject(INJECT_DEBOUNCE_MS);
        }
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST) return;

        try {
            var rec = context.currentRecord;

            if (isLineLocked(rec)) return;

            if (context.fieldId === FIELD.METHOD) {
                handleMethodChange(rec);
                // Inject synchronously after method change — fast feedback
                injectButtonsNow();
            }
        } catch (e) {
            logErr('fieldChanged failed', e, { field: context.fieldId });
        }
    }

    function postSourcing(context) {
        if (context.sublistId === SUBLIST) {
            scheduleInject(INJECT_DEBOUNCE_MS);
        }
    }

    function sublistChanged(context) {
        if (context && context.sublistId === SUBLIST) {
            scheduleInject(INJECT_DEBOUNCE_MS);
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

            if (!item) {
                dialog.alert({ title: 'Item Required', message: 'Please select an item before choosing TO sourcing.' });
                return false;
            }
            if (!fromLoc) {
                dialog.alert({ title: 'Source Location Required', message: 'Click the Pick Location button on this line to choose a source location.' });
                return false;
            }
            return true;
        } catch (e) {
            logErr('validateLine failed', e);
            return true;
        }
    }

    // ---------------- Handlers ----------------

    function handleMethodChange(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');

        if (method === SOURCING_METHOD_TO) {
            // Populate Qty to Transfer = backordered qty (fallback line qty) for audit / engine reference.
            // Not used as picker input anymore, but keeps the field meaningful.
            var qtyToWrite = resolveLineQtyRequired(rec, /*currentLine*/ true);
            if (qtyToWrite > 0) {
                rec.setCurrentSublistValue({
                    sublistId: SUBLIST,
                    fieldId: FIELD.QTY_TRANSFER,
                    value: qtyToWrite,
                    ignoreFieldChange: true
                });
            }
        } else {
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: '', ignoreFieldChange: true });
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
            injectButtonsNow();
        } catch (e) {
            logErr('handlePickerSelection failed', e, { payload: payload });
        }
    }

    // ---------------- Native-field derivation ----------------

    /**
     * Pull qty required for the picker:
     *   1. line backordered qty (if > 0)
     *   2. line quantity (fallback)
     *
     * currentLine = true uses getCurrentSublistValue (line being edited)
     * currentLine = false reads by line index — pass extra `lineIdx`
     */
    function resolveLineQtyRequired(rec, currentLine, lineIdx) {
        var bo, qty;
        try {
            if (currentLine) {
                bo = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered' }) || '0');
                qty = parseFloat(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'quantity' }) || '0');
            } else {
                bo = parseFloat(rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered', line: lineIdx }) || '0');
                qty = parseFloat(rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantity', line: lineIdx }) || '0');
            }
        } catch (e) {
            // quantitybackordered may not exist on the form yet (new SO) — fall through
            bo = 0;
        }
        if (bo > 0) return bo;
        return qty || 0;
    }

    /**
     * Destination location: line location, fallback to header location.
     */
    function resolveDestinationLocation(rec, currentLine, lineIdx) {
        var lineLoc;
        try {
            if (currentLine) {
                lineLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'location' });
            } else {
                lineLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: lineIdx });
            }
        } catch (e) {}

        if (lineLoc) return lineLoc;
        return rec.getValue({ fieldId: 'location' }) || '';
    }

    // ---------------- Picker invocation ----------------

    function canOpenPicker(rec) {
        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        var item = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'item' });
        var qtyRequired = resolveLineQtyRequired(rec, true);
        var destLoc = resolveDestinationLocation(rec, true);
        var subsidiary = rec.getValue({ fieldId: 'subsidiary' });

        if (method !== SOURCING_METHOD_TO) {
            dialog.alert({ title: 'Set Sourcing Method', message: 'Change Sourcing Method on this line to "Transfer Order" first.' });
            return false;
        }
        if (!item) {
            dialog.alert({ title: 'Item Required', message: 'Select an item before choosing a source location.' });
            return false;
        }
        if (!qtyRequired || qtyRequired <= 0) {
            dialog.alert({ title: 'Qty Required', message: 'Line has no backordered qty or quantity to transfer.' });
            return false;
        }
        if (!destLoc) {
            dialog.alert({ title: 'Destination Location Required', message: 'Set a Location on this line, or on the SO header, before opening the picker.' });
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
            var qtyRequired = resolveLineQtyRequired(rec, true);
            var destLoc = resolveDestinationLocation(rec, true);
            var subsidiary = rec.getValue({ fieldId: 'subsidiary' });
            var soId = rec.id || '';
            var lineIndex = rec.getCurrentSublistIndex({ sublistId: SUBLIST });

            pendingPickerLineIndex = lineIndex;

            var pickerUrl = url.resolveScript({
                scriptId: PICKER_SCRIPT_ID,
                deploymentId: PICKER_DEPLOY_ID,
                params: {
                    itemId: item,
                    qtyRequired: qtyRequired,
                    destLocationId: destLoc,
                    subsidiaryId: subsidiary,
                    soId: soId,
                    lineId: lineIndex
                }
            });

            dbg('openPicker', { qtyRequired: qtyRequired, destLoc: destLoc, item: item });

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

    // ---------------- DOM injection (fast path) ----------------

    function scheduleInject(delayMs) {
        if (injectTimer) clearTimeout(injectTimer);
        injectTimer = setTimeout(function () {
            injectTimer = null;
            injectButtonsNow();
        }, delayMs || INJECT_DEBOUNCE_MS);
    }

    function injectButtonsNow() {
        try { injectButtons(); } catch (e) { logErr('injectButtons failed', e); }
    }

    function initialInjectWithRetry(attemptIdx) {
        injectButtonsNow();
        var table = document.getElementById('item_splits');
        if (table) return; // success
        if (attemptIdx >= INITIAL_RETRY_DELAYS.length) {
            dbg('initialInject:givingUp');
            return;
        }
        setTimeout(function () {
            initialInjectWithRetry(attemptIdx + 1);
        }, INITIAL_RETRY_DELAYS[attemptIdx]);
    }

    function injectButtons() {
        var table = document.getElementById('item_splits');
        if (!table) return;

        var rec;
        try { rec = currentRecord.get(); } catch (e) { return; }

        var lineCount;
        try {
            lineCount = rec.getLineCount({ sublistId: SUBLIST });
        } catch (e) {
            return;
        }

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
                // Only rewrite innerHTML if it's actually changing (avoids flicker)
                if (!cell.querySelector('button.' + BTN_CLASS)) {
                    cell.innerHTML = '<button type="button" class="' + BTN_CLASS + '" ' +
                        'style="padding:3px 10px;font-size:11px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;" ' +
                        'onclick="window.bcOpenPicker(' + i + ');return false;">Pick Location</button>';
                } else {
                    // Update onclick line index in case rows shifted
                    var btn = cell.querySelector('button.' + BTN_CLASS);
                    btn.setAttribute('onclick', 'window.bcOpenPicker(' + i + ');return false;');
                }
            } else {
                if (cell.innerHTML) cell.innerHTML = '';
            }
        }
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

    function startObserver() {
        var target = document.getElementById('item_splits') || document.body;
        if (!target || observer) return;

        try {
            observer = new MutationObserver(function (mutations) {
                var structural = false;
                for (var i = 0; i < mutations.length; i++) {
                    var m = mutations[i];
                    if (m.type === 'childList' && (m.addedNodes.length || m.removedNodes.length)) {
                        // Ignore mutations caused by our own cell inject
                        var isOurs = false;
                        for (var j = 0; j < m.addedNodes.length; j++) {
                            var n = m.addedNodes[j];
                            if (n.classList && (n.classList.contains(BTN_CELL_CLASS) || n.classList.contains(BTN_CLASS))) {
                                isOurs = true; break;
                            }
                        }
                        if (!isOurs) { structural = true; break; }
                    }
                }
                if (structural) scheduleInject(INJECT_DEBOUNCE_MS);
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