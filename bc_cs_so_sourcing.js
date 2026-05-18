/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 *
 * BC SO Sourcing Client Script
 *
 * Capabilities:
 *   - Inject "Pick Location" buttons into the item sublist DOM
 *   - Manage method/from-location interactions and default transfer qty from SO line qty
 *   - Open inventory picker popup, receive selection
 *   - Capture a snapshot of locked line values on pageInit so saveRecord can
 *     compare current values and block before round-tripping to the server
 *   - Block header subsidiary / location changes when linked TOs exist
 *   - Block close/cancel attempts client-side too
 *   - Clear copied sourcing/linkage fields on full SO Copy and Copy Line
 */
define(['N/url', 'N/currentRecord', 'N/ui/dialog', 'N/search', 'N/runtime'], function (url, currentRecord, dialog, search, runtime) {

    var DEBUG = true;

    var SOURCING_METHOD_STOCK = '1';
    var SOURCING_METHOD_PO = '2';
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
    var ROLE_SOURCING_ADMIN_FIELD = 'custrecord_bc_sourcing_admin_role';

    var LINE_FIELD = {
        ITEM: 'item',
        QUANTITY: 'quantity',
        LOCATION: 'location'
    };

    var BTN_CLASS = 'bc-pick-loc-btn';
    var BTN_CELL_CLASS = 'bc-pick-loc-cell';

    var INJECT_DEBOUNCE_MS = 30;
    var INITIAL_RETRY_DELAYS = [50, 150, 400, 1000];
    var COPY_CLEANUP_RETRY_DELAYS = [100, 400, 1000, 2000, 4000];

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

    var CANCELLED_TO_STATUSES = {
        'TrnfrOrd:H': true,
        'H': true,
        'cancelled': true,
        'cancelledOrder': true,
        'Cancelled': true,
          'TrnfrOrd:G': true,
    'G': true,
    'closed': true,
    'closedOrder': true,
    'Closed': true
    };

    var LOCKED_FIELD_GUARDS = [
        { field: 'item',             label: 'Item' },
        { field: 'quantity',         label: 'Quantity' },
        { field: 'location',         label: 'Line Location' },
        { field: 'isclosed',         label: 'Line Closed' },
        { field: FIELD.METHOD,       label: 'Sourcing Method' },
        { field: FIELD.FROM_LOC,     label: 'Source From Location' },
        { field: FIELD.QTY_TRANSFER, label: 'Qty to Transfer' }
    ];

    // Snapshot of original values for locked lines, taken at pageInit
    var lockedSnapshot = null; // { lineId -> { lineNum, values } }
    var initialLineIds = null; // { lineId -> true } for lines loaded at pageInit
    var originalHeader = null; // { subsidiary, location, status }
    var pageMode = null;        // 'create' | 'edit' | 'copy' | 'view'
    var pendingPickerLineIndex = null;
    var observer = null;
    var injectTimer = null;
    var suppressValidation = false;
    var copyCleanupInProgress = false;

    // ---------------- Logging ----------------

    function dbg(t, o) { if (DEBUG) try { console.log('[BC SO Sourcing]', t, o || ''); } catch (e) {} }
    function logErr(t, e, x) { try { console.error('[BC SO Sourcing]', t, e, x || ''); } catch (z) {} }

    // ---------------- Entry points ----------------

    function pageInit(context) {
        pageMode = (context && context.mode) || null;
        dbg('pageInit', { mode: pageMode });

        var rec = currentRecord.get();
        var copyCleanupMode = isCopyCleanupMode(rec);

        /*
         * Full SO Copy:
         * In some accounts NetSuite opens a copied SO as context.mode=create,
         * then loads copied line values asynchronously. Treat any unsaved SO as
         * copy-cleanup eligible; normal new SOs have no copied residue, so this
         * is a no-op there.
         */
        if (copyCleanupMode) {
            clearCopiedOrderSourcing(rec, 'pageInit-new-or-copy');
            scheduleCopyOrderCleanupRetries();
            lockedSnapshot = {};
            initialLineIds = {};
            originalHeader = null;
        } else {
            try {
                lockedSnapshot = buildLockedSnapshot(rec);
                initialLineIds = buildLineIdSetClient(rec);
                originalHeader = {
                    subsidiary: rec.getValue({ fieldId: 'subsidiary' }),
                    location: rec.getValue({ fieldId: 'location' }),
                    status: rec.getValue({ fieldId: 'orderstatus' }) || rec.getValue({ fieldId: 'status' })
                };
                dbg('pageInit:snapshot', {
                    lockedLines: Object.keys(lockedSnapshot).length,
                    initialLines: Object.keys(initialLineIds).length,
                    header: originalHeader
                });
            } catch (e) {
                lockedSnapshot = {};
                initialLineIds = {};
                logErr('pageInit:snapshot failed', e);
            }
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
        window.bcOpenCurrentPicker = function () {
            try {
                var r = currentRecord.get();
                if (canOpenPicker(r)) openPicker(r);
            } catch (e) { logErr('bcOpenCurrentPicker failed', e); }
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
            /*
             * Copy Line:
             * A freshly copied line may carry processed/linkage values from the
             * source line. Existing locked lines are protected by initialLineIds.
             */
            if (clearCopiedCurrentLineIfNeeded(context.currentRecord, 'lineInit-copy-line')) {
                setTimeout(injectButtonsNow, 50);
                setTimeout(injectButtonsNow, 200);
                setTimeout(injectButtonsNow, 600);
            } else if (isCopyCleanupMode(context.currentRecord)) {
                defaultCurrentLineSourcingMethodForCreate(context.currentRecord, 'lineInit-create-default');
            }
        } catch (e) {
            logErr('lineInit copy-detect failed', e);
        }

        scheduleInject(INJECT_DEBOUNCE_MS);
    }

    function fieldChanged(context) {
        if (context.sublistId !== SUBLIST) {
            handleBodyFieldChange(context);
            return;
        }
        if (suppressValidation) return;

        try {
            var rec = context.currentRecord;

            clearCopiedCurrentLineIfNeeded(rec, 'fieldChanged-copy-line');
            if (context.fieldId === LINE_FIELD.ITEM && isCopyCleanupMode(rec)) {
                defaultCurrentLineSourcingMethodForCreate(rec, 'fieldChanged-item-default');
            }

            if (isLineLocked(rec)) {
                if (LOCKED_FIELD_GUARDS.some(function (g) { return g.field === context.fieldId; })) {
                    // saveRecord blocks the change with a specific message.
                }
            }
            if (context.fieldId === FIELD.METHOD) {
                handleMethodChange(rec);
                injectButtonsWithRetry();
            } else if (context.fieldId === LINE_FIELD.QUANTITY) {
                syncQtyToTransferFromLineQuantity(rec);
            }
        } catch (e) {
            logErr('fieldChanged failed', e, { field: context.fieldId });
        }
    }

    function postSourcing(context) {
        if (context.sublistId === SUBLIST) {
            if (!suppressValidation && context.fieldId === LINE_FIELD.ITEM && isCopyCleanupMode(context.currentRecord)) {
                try { defaultCurrentLineSourcingMethodForCreate(context.currentRecord, 'postSourcing-item-default'); } catch (e) { logErr('postSourcing method default failed', e); }
            }
            if (!suppressValidation &&
                (context.fieldId === LINE_FIELD.QUANTITY || context.fieldId === LINE_FIELD.ITEM)) {
                try { syncQtyToTransferFromLineQuantity(context.currentRecord); } catch (e) { logErr('postSourcing qty sync failed', e); }
            }
            scheduleInject(INJECT_DEBOUNCE_MS);
        }
    }

    function sublistChanged(context) {
        if (context && context.sublistId === SUBLIST) scheduleInject(INJECT_DEBOUNCE_MS);
    }

    function validateLine(context) {
        if (suppressValidation) return true;
        if (context.sublistId !== SUBLIST) return true;
        try {
            /*
             * This is the most reliable hook in some NetSuite transaction UIs:
             * copied line-level custom fields may not accept or keep changes made
             * during pageInit, but they do clear when the copied line is committed.
             */
            if (clearCopiedCurrentLineIfNeeded(context.currentRecord, 'validateLine-copy-cleanup', true)) {
                scheduleInject(INJECT_DEBOUNCE_MS);
                return true;
            }

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
            var copyCleanupMode = isCopyCleanupMode(rec);

            // Full SO Copy safety net. If NetSuite sourced copied values after pageInit, clear them now.
            if (copyCleanupMode) {
                clearCopiedOrderSourcing(rec, 'saveRecord-new-or-copy');
            }

            if (!validateCommittedLineSourcingRules(rec)) return false;

            // 1. Header subsidiary / location change and close/cancel checks
            if (!copyCleanupMode && originalHeader) {
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
            if (!copyCleanupMode && lockedSnapshot && hasAny(lockedSnapshot)) {
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
                    var stillLocked = isPopulated(newProc) || isPopulated(newLinkedTo);

                    if (!stillLocked) {
                        if (!validateClientAdminUnlockAllowed(oldLine)) return false;
                        continue;
                    }

                    // Partial unlock?
                    var oldProc = oldLine.values[FIELD.PROCESSED];
                    var oldLinked = oldLine.values[FIELD.LINKED_TO];
                    if ((isPopulated(oldProc) && !isPopulated(newProc) && isPopulated(newLinkedTo)) ||
                        (isPopulated(oldLinked) && !isPopulated(newLinkedTo) && isPopulated(newProc))) {
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
            return true; // Fail open - UE will catch
        }
    }

    // ---------------- Copy cleanup helpers ----------------

    function isCopyMode() {
        return String(pageMode || '').toLowerCase() === 'copy';
    }

    function isCopyCleanupMode(rec) {
        if (isCopyMode()) return true;
        if (!rec) return false;

        /*
         * NetSuite can open Copy Sales Order as create mode. A copied SO has no
         * new internal id yet, so treat unsaved create as cleanup-eligible and
         * let the residue checks decide whether anything actually clears.
         */
        var mode = String(pageMode || '').toLowerCase();
        var id = rec.id || '';
        return !id && (mode === 'create' || mode === 'copy' || mode === '');
    }

    function scheduleCopyOrderCleanupRetries() {
        for (var i = 0; i < COPY_CLEANUP_RETRY_DELAYS.length; i++) {
            setTimeout(function () {
                try { clearCopiedOrderSourcing(currentRecord.get(), 'pageInit-copy-retry'); } catch (e) { logErr('copy cleanup retry failed', e); }
            }, COPY_CLEANUP_RETRY_DELAYS[i]);
        }
    }

    function clearCopiedOrderSourcing(rec, reason) {
        if (!rec || copyCleanupInProgress) return 0;

        var cleared = 0;
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return 0; }

        suppressValidation = true;
        copyCleanupInProgress = true;
        try {
            for (var i = 0; i < lineCount; i++) {
                if (!lineHasCopiedSourcingResidue(rec, i)) continue;

                try {
                    rec.selectLine({ sublistId: SUBLIST, line: i });
                    clearCurrentLineSourcingFields(rec, reason);
                    rec.commitLine({ sublistId: SUBLIST, ignoreRecalc: true });
                    cleared++;
                } catch (lineErr) {
                    logErr('copy cleanup line failed', lineErr, { reason: reason, line: i + 1 });
                }
            }
        } finally {
            copyCleanupInProgress = false;
            suppressValidation = false;
        }

        if (cleared) {
            dbg('clearCopiedOrderSourcing:done', { reason: reason, cleared: cleared });
            injectButtonsWithRetry();
        }
        return cleared;
    }

    function clearCopiedCurrentLineIfNeeded(rec, reason, allowCopyMode) {
        if (!rec || copyCleanupInProgress) return false;
        if (isCopyCleanupMode(rec) && !allowCopyMode) return false;

        if (!currentLineHasCopiedSourcingResidue(rec)) return false;

        var lineId = getCurrentLineIdClient(rec);
        if (!isCopyCleanupMode(rec) && lineId && initialLineIds && initialLineIds[lineId]) {
            return false;
        }

        clearCurrentLineSourcingFields(rec, reason);
        dbg('clearCopiedCurrentLineIfNeeded:done', { reason: reason, lineId: lineId || '(new)' });
        return true;
    }

    function lineHasCopiedSourcingResidue(rec, lineIdx) {
        /*
         * Do not use Source From Location or Qty to Transfer as the detector.
         * Those can be legitimate values on a brand-new SO line. Copied residue
         * means result/control fields from an existing sourcing run came across.
         */
        return isPopulated(safeLineValue(rec, FIELD.LINKED_TO, lineIdx)) ||
            isPopulated(safeLineValue(rec, FIELD.PROCESSED, lineIdx)) ||
            isPopulated(safeLineValue(rec, FIELD.ERROR, lineIdx));
    }

    function currentLineHasCopiedSourcingResidue(rec) {
        return isPopulated(safeCurrentLineValue(rec, FIELD.LINKED_TO)) ||
            isPopulated(safeCurrentLineValue(rec, FIELD.PROCESSED)) ||
            isPopulated(safeCurrentLineValue(rec, FIELD.ERROR));
    }

    function clearCurrentLineSourcingFields(rec, reason) {
        if (!rec) return;

        setCurrentLineValueQuiet(rec, FIELD.METHOD, getDefaultSourcingMethodForCurrentLine(rec));
        setCurrentLineValueQuiet(rec, FIELD.LINKED_TO, '');
        setCurrentLineValueQuiet(rec, FIELD.PROCESSED, false);
        setCurrentLineValueQuiet(rec, FIELD.ERROR, '');
        setCurrentLineValueQuiet(rec, FIELD.FROM_LOC, '');
        setCurrentLineValueQuiet(rec, FIELD.QTY_TRANSFER, '');
        dbg('clearCurrentLineSourcingFields', { reason: reason });
    }

    function defaultCurrentLineSourcingMethodForCreate(rec, reason) {
        if (!rec) return false;

        var method = String(safeCurrentLineValue(rec, FIELD.METHOD) || '');
        if (method === SOURCING_METHOD_TO) return false;
        if (method && method !== SOURCING_METHOD_STOCK && method !== SOURCING_METHOD_PO) return false;

        var defaultMethod = getDefaultSourcingMethodForCurrentLine(rec);
        if (method === defaultMethod) return false;

        setCurrentLineValueQuiet(rec, FIELD.METHOD, defaultMethod);
        dbg('defaultCurrentLineSourcingMethodForCreate', { reason: reason, method: defaultMethod });
        return true;
    }

    function getDefaultSourcingMethodForCurrentLine(rec) {
        return currentLineHasNativePO(rec) ? SOURCING_METHOD_PO : SOURCING_METHOD_STOCK;
    }

    function currentLineHasNativePO(rec) {
        return hasNativePOValue(safeCurrentLineValue(rec, 'createpo')) ||
            hasNativePOValue(safeCurrentLineValue(rec, 'createdropship')) ||
            hasNativePOValue(safeCurrentLineValue(rec, 'povendor'));
    }

    function setCurrentLineValueQuiet(rec, fieldId, value) {
        try {
            rec.setCurrentSublistValue({
                sublistId: SUBLIST,
                fieldId: fieldId,
                value: value,
                ignoreFieldChange: true
            });
            return true;
        } catch (e) {
            logErr('setCurrentLineValueQuiet failed', e, { fieldId: fieldId });
            return false;
        }
    }

    function isPopulated(value) {
        if (value === null || value === undefined || value === '') return false;
        if (value === false || value === 'F' || value === 'false') return false;
        if (Object.prototype.toString.call(value) === '[object Array]' && value.length === 0) return false;
        return true;
    }

    // ---------------- Validation helpers ----------------

    function validateCurrentLineSourcingRules(rec) {
        var method = String(safeCurrentLineValue(rec, FIELD.METHOD) || '');
        if (method !== SOURCING_METHOD_TO) return true;

        var processed = safeCurrentLineValue(rec, FIELD.PROCESSED);
        var linkedTo = safeCurrentLineValue(rec, FIELD.LINKED_TO);
        if (isPopulated(processed) || isPopulated(linkedTo)) return true;

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
            if (isPopulated(processed) || isPopulated(linkedTo)) continue;

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
            syncQtyToTransferFromLineQuantity(rec);
        } else {
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, value: '', ignoreFieldChange: true });
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER, value: '', ignoreFieldChange: true });
        }
    }

    function syncQtyToTransferFromLineQuantity(rec) {
        if (!rec || suppressValidation || isLineLocked(rec)) return;

        var method = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        if (method !== SOURCING_METHOD_TO) return;

        var qtyRequired = calculateCurrentQtyToTransfer(rec);
        var value = qtyRequired > 0 ? qtyRequired : '';
        var currentValue = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.QTY_TRANSFER });

        if (String(currentValue == null ? '' : currentValue) === String(value == null ? '' : value)) return;

        rec.setCurrentSublistValue({
            sublistId: SUBLIST,
            fieldId: FIELD.QTY_TRANSFER,
            value: value,
            ignoreFieldChange: true
        });
        try {
            rec.setCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, value: '', ignoreFieldChange: true });
        } catch (e) {}
    }

    function handleBodyFieldChange(context) {
        // Currently passive. saveRecord catches protected header changes.
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

            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            if (isPopulated(processed) || isPopulated(linkedTo)) {
                dbg('handlePickerSelection:skipLocked');
                pendingPickerLineIndex = null;
                return;
            }

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
            injectButtonsWithRetry();
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
        if (!qtyRequired || qtyRequired <= 0) { dialog.alert({ title: 'Qty Required', message: 'Line has no Qty to Transfer or line quantity.' }); return false; }
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
            var currentFromLoc = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC }) || '';

            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            var locked = isPopulated(processed) || isPopulated(linkedTo);
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

        return calculateCurrentQtyToTransfer(rec);
    }

    function calculateCurrentQtyToTransfer(rec) {
        var ordered = getCurrentNumericValue(rec, LINE_FIELD.QUANTITY);
        return ordered !== null && ordered > 0 ? ordered : 0;
    }

    function getCurrentNumericValue(rec, fieldId) {
        var value;
        try {
            value = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: fieldId });
        } catch (e) {
            return null;
        }
        if (value === null || value === undefined || value === '') return null;

        var parsed = parseFloat(value);
        return isNaN(parsed) ? null : parsed;
    }

    // ---------------- DOM injection ----------------

    function scheduleInject(delayMs) {
        if (injectTimer) clearTimeout(injectTimer);
        injectTimer = setTimeout(function () { injectTimer = null; injectButtonsNow(); }, delayMs || INJECT_DEBOUNCE_MS);
    }

    function injectButtonsNow() { try { injectButtons(); } catch (e) { logErr('injectButtons failed', e); } }

    function injectButtonsWithRetry() {
        injectButtonsNow();
        setTimeout(injectButtonsNow, 50);
        setTimeout(injectButtonsNow, 200);
        setTimeout(injectButtonsNow, 600);
    }

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

        var tbody = table.querySelector('tbody');
        if (!tbody) { dbg('injectButtons:noTbody'); return; }

        var allRows = tbody.querySelectorAll('tr[id^="item_row_"]');
        dbg('injectButtons:rows', { domRows: allRows.length, recordLines: lineCount });

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
            var shouldShow = (method === SOURCING_METHOD_TO);

            dbg('injectButtons:line', { idx: i, rowId: row.id, method: method, shouldShow: shouldShow });
            syncPickButtonCell(row, i, shouldShow, false);
        }

        var currentMethod = '';
        try {
            currentMethod = String(rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD }) || '');
        } catch (ignoreMethod) {}
        if (currentMethod === SOURCING_METHOD_TO) {
            var currentRow = findCurrentEditorRow(table);
            if (currentRow) {
                dbg('injectButtons:currentLineFallback', { rowId: currentRow.id || '(no id)', currentLine: currentLine });
                syncPickButtonCell(currentRow, currentLine, true, true);
            }
        }
    }

    function syncPickButtonCell(row, lineIndex, shouldShow, useCurrentLine) {
        if (!row) return;

        var cell = row.querySelector('td.' + BTN_CELL_CLASS);
        if (!cell) {
            cell = document.createElement('td');
            cell.className = BTN_CELL_CLASS;
            cell.style.padding = '2px 6px';
            cell.style.whiteSpace = 'nowrap';
            row.appendChild(cell);
        }

        if (shouldShow) {
            var handler = useCurrentLine
                ? 'window.bcOpenCurrentPicker();return false;'
                : 'window.bcOpenPicker(' + lineIndex + ');return false;';
            var html = '<button type="button" class="' + BTN_CLASS + '" ' +
                'style="padding:3px 10px;font-size:11px;cursor:pointer;background:#125ab2;color:#fff;border:1px solid #0e4a94;border-radius:3px;" ' +
                'onclick="' + handler + '">Pick Location</button>';
            if (cell.innerHTML !== html) cell.innerHTML = html;
        } else if (cell.innerHTML) {
            cell.innerHTML = '';
        }
    }

    function findCurrentEditorRow(table) {
        var active = document.activeElement;
        var row = closestRow(active);
        if (isUsableItemRow(table, row)) return row;

        var selectors = [
            'tr.uir-machine-row-focused',
            'tr.uir-machine-row-selected',
            'tr.uir-machine-row-current',
            'tr.ns-sublist-currentline',
            'tr[id*="_row_current"]',
            'tr[id^="item_row_"].uir-list-row-tr-selected'
        ];
        for (var i = 0; i < selectors.length; i++) {
            var candidate = table.querySelector(selectors[i]);
            if (isUsableItemRow(table, candidate)) return candidate;
        }
        return null;
    }

    function closestRow(el) {
        while (el && el !== document) {
            if (el.tagName && String(el.tagName).toLowerCase() === 'tr') return el;
            el = el.parentNode;
        }
        return null;
    }

    function isUsableItemRow(table, row) {
        if (!row || !table || !table.contains(row)) return false;
        if (row.querySelectorAll('td').length < 2) return false;
        return !(row.className || '').match(/header|total/i);
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
            if (!isPopulated(processed) && !isPopulated(linkedTo)) continue;

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

    function buildLineIdSetClient(rec) {
        var set = {};
        var lineCount;
        try { lineCount = rec.getLineCount({ sublistId: SUBLIST }); } catch (e) { return set; }
        for (var i = 0; i < lineCount; i++) {
            var id = getLineIdClient(rec, i);
            if (id) set[id] = true;
        }
        return set;
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

    function getCurrentLineIdClient(rec) {
        try {
            var id = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'line' });
            if (id) return String(id);
        } catch (e) {}
        try {
            var u = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: 'lineuniquekey' });
            if (u) return String(u);
        } catch (e) {}
        return null;
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

    function validateClientAdminUnlockAllowed(oldLine) {
        if (!isCurrentUserSourcingAdminClient()) {
            dialog.alert({
                title: 'Administrator Required',
                message: 'Line ' + oldLine.lineNum + ': only an Administrator or Sourcing Admin role can clear Linked Transfer Order and Sourcing Processed.'
            });
            return false;
        }

        var linkedTo = oldLine.values[FIELD.LINKED_TO];
        if (!linkedTo) return true;

        var statusVal = getTransferOrderStatusValueClient(linkedTo);
        if (!statusVal) {
            dialog.alert({
                title: 'Cannot Verify Transfer Order',
                message: 'Line ' + oldLine.lineNum + ': linked Transfer Order status could not be verified.'
            });
            return false;
        }
        if (!CANCELLED_TO_STATUSES[statusVal]) {
            dialog.alert({
                title: 'Cannot Unlock Line',
                message: 'Line ' + oldLine.lineNum + ': linked Transfer Order must be Cancelled before clearing Linked Transfer Order and Sourcing Processed. Current status: ' + statusVal + '.'
            });
            return false;
        }

        return true;
    }

    function isCurrentUserSourcingAdminClient() {
        try {
            var user = runtime.getCurrentUser();
            if (String(user.role) === '3' || String(user.roleId || '').toLowerCase() === 'administrator') return true;
            return roleHasSourcingAdminFlagClient(user.role);
        } catch (e) {
            logErr('isCurrentUserSourcingAdminClient failed', e);
            return false;
        }
    }

    function roleHasSourcingAdminFlagClient(roleId) {
        if (!roleId) return false;

        try {
            var look = search.lookupFields({
                type: 'role',
                id: roleId,
                columns: [ROLE_SOURCING_ADMIN_FIELD]
            });
            return isTrueValue(look[ROLE_SOURCING_ADMIN_FIELD]);
        } catch (e) {
            logErr('roleHasSourcingAdminFlagClient failed', e, { roleId: roleId, fieldId: ROLE_SOURCING_ADMIN_FIELD });
            return false;
        }
    }

    function getTransferOrderStatusValueClient(toId) {
        try {
            var look = search.lookupFields({
                type: search.Type && search.Type.TRANSFER_ORDER ? search.Type.TRANSFER_ORDER : 'transferorder',
                id: toId,
                columns: ['status']
            });
            return look.status && look.status[0] ? (look.status[0].value || look.status[0].text || '') : '';
        } catch (e) {
            logErr('getTransferOrderStatusValueClient failed', e, { toId: toId });
            return '';
        }
    }

    function isLineLocked(rec) {
        try {
            var processed = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED });
            var linkedTo = rec.getCurrentSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO });
            return isPopulated(processed) || isPopulated(linkedTo);
        } catch (e) { return false; }
    }

    function isTrueValue(value) {
        if (value === true) return true;
        var text = String(value == null ? '' : value).toLowerCase();
        return text === 't' || text === 'true' || text === 'yes' || text === '1';
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
