/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 *
 * BC SO Sourcing User Event (with lock-state enforcement)
 *
 * beforeSubmit:
 *   - Validate TO-sourced lines (item type, From Location, conflicts)
 *   - Enforce lock restrictions on lines that were locked in the OLD record:
 *     • cannot delete the line
 *     • cannot change item, quantity, line location, sourcing method,
 *       source from location, or qty to transfer
 *     • UNLESS the line is being unlocked in the same save (Admin correction)
 *   - Enforce header restrictions when any line currently has a linked TO:
 *     • cannot change subsidiary
 *     • cannot change header location
 *   - Block SO close/cancel (status transition to Closed/Cancelled) when any
 *     line has an active linked TO
 *   - On COPY: clear processed/linked_to/error so the engine reprocesses
 *
 * afterSubmit:
 *   - Sourcing engine: status=Pending Fulfillment, UI/Workflow context only.
 *     Recheck availability, group by source location, create one TO per group,
 *     write back linked_to + processed in a single SO save.
 */
define([
    'N/record',
    'N/search',
    'N/runtime',
    'N/log'
], function (record, search, runtime, log) {

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

    var ALLOWED_ITEM_TYPES = { 'InvtPart': true, 'Assembly': true };

    var ACTIVE_TO_STATUSES = {
        'TrnfrOrd:A': true,  // Pending Approval
        'TrnfrOrd:B': true,  // Pending Fulfillment
        'TrnfrOrd:D': true,  // Partially Fulfilled
        'TrnfrOrd:E': true,  // Pending Receipt
        'TrnfrOrd:F': true,  // Partially Received
        'TrnfrOrd:G': true   // Received (treat as active for close/cancel — inventory moved)
        // Cancelled (H) and Closed (?) intentionally not listed = inactive
    };

    var SO_STATUS_PENDING_FULFILLMENT_TEXT = 'pendingFulfillment';
    var SO_STATUS_PENDING_FULFILLMENT_CODE = 'B';

    // SO statuses that count as "closed" — for blocking close/cancel
    var SO_CLOSED_STATUSES = {
        'F': true,           // Closed
        'closedOrder': true, // text variant
        'H': true,           // Cancelled (varies by account)
        'cancelled': true
    };

    // Fields on a locked line that cannot change without Admin unlock
    var LOCKED_FIELD_GUARDS = [
        { field: 'item',           label: 'Item' },
        { field: 'quantity',       label: 'Quantity' },
        { field: 'location',       label: 'Line Location' },
        { field: FIELD.METHOD,     label: 'Sourcing Method' },
        { field: FIELD.FROM_LOC,   label: 'Source From Location' },
        { field: FIELD.QTY_TRANSFER, label: 'Qty to Transfer' }
    ];

    // ---------- Entry points ----------

    function beforeSubmit(context) {
        try {
            var T = context.UserEventType;
            var rec = context.newRecord;
            var oldRec = context.oldRecord;

            // DELETE: block if active linked TOs exist on this SO
            if (context.type === T.DELETE) {
                blockDeleteIfActiveLinkedTOs(oldRec || rec);
                return;
            }

            // COPY: clear processed/linked_to/error so the new SO can re-source
            if (context.type === T.COPY) {
                cleanupCopiedLines(rec);
                // Still validate the resulting lines
                validateAllLines(rec);
                return;
            }

            // CREATE / EDIT / XEDIT
            if (context.type === T.CREATE || context.type === T.EDIT || context.type === T.XEDIT) {

                // 1. Per-line validation
                validateAllLines(rec);

                // 2. Lock restrictions (only meaningful if we have an old record)
                if (oldRec) {
                    enforceLockRestrictions(oldRec, rec);
                    enforceHeaderRestrictions(oldRec, rec);
                    blockCloseCancelIfActiveLinkedTOs(oldRec, rec);
                }
            }
        } catch (e) {
            // Re-throw so the save is actually blocked
            throw e;
        }
    }

    function afterSubmit(context) {
        try {
            var T = context.UserEventType;
            if (context.type !== T.CREATE && context.type !== T.EDIT && context.type !== T.XEDIT) return;

            var ctxType = runtime.executionContext;
            var allowed = [runtime.ContextType.USER_INTERFACE, runtime.ContextType.WORKFLOW];
            if (allowed.indexOf(ctxType) === -1) {
                log.debug('afterSubmit:skipContext', { context: ctxType });
                return;
            }

            var soId = context.newRecord.id;
            var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

            var status = so.getValue({ fieldId: 'orderstatus' }) || so.getValue({ fieldId: 'status' });
            if (status !== SO_STATUS_PENDING_FULFILLMENT_TEXT && status !== SO_STATUS_PENDING_FULFILLMENT_CODE) {
                log.debug('afterSubmit:skipStatus', { status: status });
                return;
            }

            runSourcingEngine(so);
        } catch (e) {
            log.error('afterSubmit failed', e);
            // Do not re-throw — afterSubmit failures shouldn't undo the SO save
        }
    }

    // ---------- Per-line validation (existing) ----------

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
            throw new Error('Line ' + lineNum + ': item type "' + itemType + '" is not supported for Transfer Order sourcing. Only Inventory and Assembly items are supported.');
        }

        var fromLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: lineIdx });
        if (!fromLoc) {
            throw new Error('Line ' + lineNum + ': Source From Location is required for Transfer Order sourcing.');
        }

        var lineDestLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: lineIdx })
                       || rec.getValue({ fieldId: 'location' });
        if (String(fromLoc) === String(lineDestLoc)) {
            throw new Error('Line ' + lineNum + ': Source From Location cannot equal the destination Location.');
        }

        var isSpecialOrder = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'createpo', line: lineIdx });
        if (isSpecialOrder) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a line that also has Special Order / Drop Ship configured.');
        }
        var poVendor = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'povendor', line: lineIdx });
        if (poVendor) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a line with a PO Vendor populated.');
        }
    }

    // ---------- Lock restrictions (NEW) ----------

    function enforceLockRestrictions(oldRec, newRec) {
        var oldLocked = buildLockedLineMap(oldRec);
        if (!hasAny(oldLocked)) return;

        var newLineMap = buildLineIdMap(newRec);

        Object.keys(oldLocked).forEach(function (lineId) {
            var oldLine = oldLocked[lineId];
            var newIdx = newLineMap[lineId];

            // ----- Deletion check -----
            if (newIdx === undefined || newIdx === null) {
                throw new Error('Cannot delete line ' + oldLine.lineNum +
                    ': a Transfer Order is linked to this line. To remove the line, an Administrator must first cancel the linked TO and clear the Linked TO, Sourcing Processed, and Sourcing Error fields.');
            }

            // ----- Is the line still locked in newRec? -----
            var newProcessed = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: newIdx });
            var newLinkedTo = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: newIdx });
            var stillLocked = !!newProcessed || !!newLinkedTo;

            // If Admin unlocked the line (cleared linked_to + processed), allow all field changes.
            // This is the Admin correction flow.
            if (!stillLocked) return;

            // ----- Field change check -----
            for (var k = 0; k < LOCKED_FIELD_GUARDS.length; k++) {
                var guard = LOCKED_FIELD_GUARDS[k];
                var oldVal = oldLine.values[guard.field];
                var newVal = newRec.getSublistValue({ sublistId: SUBLIST, fieldId: guard.field, line: newIdx });

                if (String(oldVal == null ? '' : oldVal) !== String(newVal == null ? '' : newVal)) {
                    throw new Error('Cannot change "' + guard.label + '" on line ' + oldLine.lineNum +
                        ': a Transfer Order is linked to this line. To modify, an Administrator must first cancel the linked TO and clear the Linked TO, Sourcing Processed, and Sourcing Error fields.');
                }
            }
        });
    }

    // ---------- Header restrictions (NEW) ----------

    function enforceHeaderRestrictions(oldRec, newRec) {
        if (!anyLinkedTOsInRecord(newRec)) return;

        var oldSub = oldRec.getValue({ fieldId: 'subsidiary' });
        var newSub = newRec.getValue({ fieldId: 'subsidiary' });
        if (String(oldSub || '') !== String(newSub || '')) {
            throw new Error('Cannot change Subsidiary: this SO has one or more lines with linked Transfer Orders. Cancel and clear the linked TOs first.');
        }

        var oldLoc = oldRec.getValue({ fieldId: 'location' });
        var newLoc = newRec.getValue({ fieldId: 'location' });
        if (String(oldLoc || '') !== String(newLoc || '')) {
            throw new Error('Cannot change header Location: this SO has one or more lines with linked Transfer Orders. Cancel and clear the linked TOs first.');
        }
    }

    // ---------- Close/Cancel block ----------

    function blockCloseCancelIfActiveLinkedTOs(oldRec, newRec) {
        var oldStatus = String(oldRec.getValue({ fieldId: 'orderstatus' }) || oldRec.getValue({ fieldId: 'status' }) || '');
        var newStatus = String(newRec.getValue({ fieldId: 'orderstatus' }) || newRec.getValue({ fieldId: 'status' }) || '');

        // Only check on transitions into Closed/Cancelled
        if (oldStatus === newStatus) return;
        if (!SO_CLOSED_STATUSES[newStatus]) return;

        var blockingLines = getActiveLinkedTOLines(newRec);
        if (blockingLines.length) {
            throw new Error('Cannot close/cancel this SO: the following lines have active Transfer Orders that must be cancelled or operationally reversed first: ' + blockingLines.join('; '));
        }
    }

    function blockDeleteIfActiveLinkedTOs(rec) {
        var blockingLines = getActiveLinkedTOLines(rec);
        if (blockingLines.length) {
            throw new Error('Cannot delete this SO: the following lines have active Transfer Orders: ' + blockingLines.join('; ') + '. An Administrator must cancel or operationally reverse the linked TO(s) first.');
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
                var statusVal = look.status && look.status[0] ? look.status[0].value : '';
                if (ACTIVE_TO_STATUSES[statusVal]) {
                    blocking.push('Line ' + (i + 1) + ' (' + (look.tranid || ('TO#' + linkedTo)) + ', status ' + statusVal + ')');
                }
            } catch (e) {
                log.error('getActiveLinkedTOLines:lookup', e);
            }
        }
        return blocking;
    }

    // ---------- COPY cleanup ----------

    function cleanupCopiedLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i, value: false });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: i, value: '' });
        }
    }

    // ---------- Sourcing engine (unchanged from working version) ----------

    function runSourcingEngine(so) {
        var soId = so.id;
        var tranId = so.getValue({ fieldId: 'tranid' }) || '';
        var subsidiary = so.getValue({ fieldId: 'subsidiary' });
        var headerLocation = so.getValue({ fieldId: 'location' });

        var qualifying = collectQualifyingLines(so, headerLocation);
        if (!qualifying.length) {
            log.debug('engine:noQualifyingLines', { soId: soId });
            return;
        }

        var checked = recheckAvailability(qualifying);

        var groups = {};
        var skipped = [];
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

        writebackResults(soId, success, failed, skipped);

        log.audit('engine:done', { soId: soId, success: success.length, failed: failed.length, skipped: skipped.length });
    }

    function collectQualifyingLines(so, headerLocation) {
        var lineCount = so.getLineCount({ sublistId: SUBLIST });
        var lines = [];
        for (var i = 0; i < lineCount; i++) {
            var method = String(so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            if (method !== SOURCING_METHOD_TO) continue;
            if (so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i })) continue;
            if (so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i })) continue;

            var fromLoc = so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: i });
            if (!fromLoc) continue;
            var item = so.getSublistValue({ sublistId: SUBLIST, fieldId: 'item', line: i });
            if (!item) continue;

            var bo = parseFloat(so.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered', line: i }) || '0');
            var qty = parseFloat(so.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantity', line: i }) || '0');
            var qtyRequired = bo > 0 ? bo : qty;
            if (qtyRequired <= 0) continue;

            lines.push({
                lineIdx: i,
                lineNum: i + 1,
                item: item,
                fromLoc: fromLoc,
                destLoc: so.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: i }) || headerLocation,
                qtyRequired: qtyRequired,
                units: so.getSublistValue({ sublistId: SUBLIST, fieldId: 'units', line: i })
            });
        }
        return lines;
    }

    function recheckAvailability(lines) {
        var pairs = {};
        lines.forEach(function (l) { pairs[l.item + '|' + l.fromLoc] = { item: l.item, location: l.fromLoc }; });
        var availMap = {};
        Object.keys(pairs).forEach(function (key) {
            var p = pairs[key];
            try {
                var s = search.create({
                    type: 'inventorybalance',
                    filters: [['item', 'anyof', p.item], 'AND', ['location', 'anyof', p.location]],
                    columns: [search.createColumn({ name: 'available' })]
                });
                var avail = 0;
                s.run().each(function (r) { avail = parseFloat(r.getValue({ name: 'available' }) || '0'); return false; });
                availMap[key] = avail;
            } catch (e) {
                availMap[key] = 0;
            }
        });

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
        to.setValue({ fieldId: 'incoterm', value: 1 });
        try { to.setValue({ fieldId: 'orderstatus', value: 'A' }); } catch (e) {}

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

    function writebackResults(soId, success, failed, skipped) {
        if (!success.length && !failed.length && !skipped.length) return;
        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

        success.forEach(function (s) {
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: s.lineIdx, value: s.toId });
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: s.lineIdx, value: true });
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: s.lineIdx, value: '' });
        });
        failed.forEach(function (f) {
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: f.lineIdx, value: f.error });
        });
        skipped.forEach(function (l) {
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: l.lineIdx, value: l.error });
        });

        so.save({ ignoreMandatoryFields: true, enableSourcing: false });
    }

    // ---------- Diff helpers ----------

    /**
     * Build a map of line ID -> { lineNum, values: {fieldId -> value} } for
     * every line that is locked (processed or linked_to populated) in the record.
     */
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

            map[id] = { lineNum: i + 1, values: values };
        }
        return map;
    }

    /**
     * Build a map of line ID -> line index in the record.
     */
    function buildLineIdMap(rec) {
        var map = {};
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            var id = getLineId(rec, i);
            if (id) map[id] = i;
        }
        return map;
    }

    /**
     * Get a stable identifier for a sublist line. Tries 'line' first
     * (database line ID), falls back to 'lineuniquekey'.
     */
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
        for (var k in obj) { if (obj.hasOwnProperty(k)) return true; }
        return false;
    }

    return {
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
