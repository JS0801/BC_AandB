/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 *
 * BC SO Sourcing User Event
 *
 * beforeSubmit:
 *   - Blocks save when TO-sourced lines fail validation (item type, missing
 *     From Location, conflicting native sourcing fields).
 *   - Blocks SO close/cancel when any line has an active linked TO.
 *
 * afterSubmit:
 *   - Runs the sourcing engine: for each unlocked TO-sourced line, re-check
 *     availability, group by source location, create one Transfer Order per
 *     source location, and write back Linked TO + Sourcing Processed flag.
 *
 * Phase 1 scope: UI + workflow approval contexts only. No integration-driven
 * TO creation. NetSuite remains system of record for TO status / fulfillment.
 */
define([
    'N/record',
    'N/search',
    'N/runtime',
    'N/log'
], function (record, search, runtime, log) {

    // ---------- Constants ----------

    var SOURCING_METHOD_TO = '3';   // customlist_bc_sourcing_method internal ID for "Transfer Order"
    var SUBLIST = 'item';

    var FIELD = {
        METHOD:       'custcol_bc_sourcing_method',
        FROM_LOC:     'custcol_bc_source_from_location',
        QTY_TRANSFER: 'custcol_bc_qty_to_transfer',
        LINKED_TO:    'custcol_bc_linked_to',
        PROCESSED:    'custcol_bc_sourcing_processed',
        ERROR:        'custcol_bc_sourcing_error'
    };

    // Item types allowed for TO sourcing (per spec)
    var ALLOWED_ITEM_TYPES = {
        'InvtPart': true,    // Inventory Item
        'Assembly': true     // Assembly / BOM
    };

    // Native TO statuses that count as "active" — block SO close/cancel when present
    var ACTIVE_TO_STATUSES = {
        'TrnfrOrd:A': true,  // Pending Approval
        'TrnfrOrd:B': true,  // Pending Fulfillment
        'TrnfrOrd:C': true,  // Rejected (treat as inactive? leaving out for now)
        'TrnfrOrd:D': true,  // Partially Fulfilled
        'TrnfrOrd:E': true,  // Pending Receipt
        'TrnfrOrd:F': true,  // Partially Received
        'TrnfrOrd:G': true   // Received
    };
    // Note: status internal IDs above are NetSuite defaults. May need adjustment
    // per A&B account. Confirmed values should be plugged in after validation.

    // SO status that triggers the engine
    var SO_STATUS_PENDING_FULFILLMENT = 'pendingFulfillment';

    // ---------- Entry points ----------

    function beforeSubmit(context) {
        try {
            // Run validation on create + edit + xedit + copy
            var validTypes = [context.UserEventType.CREATE, context.UserEventType.EDIT, context.UserEventType.XEDIT, context.UserEventType.COPY];
            if (validTypes.indexOf(context.type) === -1 &&
                context.type !== 'cancel' &&
                context.type !== 'close') {
                return;
            }

            var rec = context.newRecord;

            // Handle close/cancel separately — block if active linked TOs exist
            if (context.type === 'cancel' || context.type === 'close') {
                blockIfActiveLinkedTOs(rec);
                return;
            }

            // For copy operations: clear processed + linked TO on all lines
            if (context.type === context.UserEventType.COPY) {
                cleanupCopiedLines(rec);
            }

            // Validate each TO-sourced line
            var lineCount = rec.getLineCount({ sublistId: SUBLIST });
            for (var i = 0; i < lineCount; i++) {
                validateLine(rec, i);
            }
        } catch (e) {
            log.error('beforeSubmit failed', e);
            throw e; // re-throw so validation errors block the save
        }
    }

    function afterSubmit(context) {
        try {
            // Only fire on CREATE / EDIT / XEDIT — not on delete or other types
            var fireTypes = [context.UserEventType.CREATE, context.UserEventType.EDIT, context.UserEventType.XEDIT];
            if (fireTypes.indexOf(context.type) === -1) return;

            // Context gate: UI + workflow only (Phase 1 scope)
            var ctxType = runtime.executionContext;
            var allowedContexts = [
                runtime.ContextType.USER_INTERFACE,
                runtime.ContextType.WORKFLOW
            ];
            if (allowedContexts.indexOf(ctxType) === -1) {
                log.debug('afterSubmit:skipContext', { context: ctxType });
                return;
            }

            // Reload as dynamic to read all current values cleanly
            var soId = context.newRecord.id;
            var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

            // Status gate: only Pending Fulfillment
            var status = so.getValue({ fieldId: 'orderstatus' }) || so.getValue({ fieldId: 'status' });
            log.debug('afterSubmit:status', { status: status });
            if (status !== SO_STATUS_PENDING_FULFILLMENT && status !== 'B') {
                log.debug('afterSubmit:skipStatus', { status: status });
                return;
            }

            runSourcingEngine(so);
        } catch (e) {
            log.error('afterSubmit failed', e);
            // Don't re-throw — afterSubmit errors shouldn't undo the SO save
        }
    }

    // ---------- beforeSubmit helpers ----------

    function validateLine(rec, lineIdx) {
        var method = String(rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: lineIdx }) || '');
        if (method !== SOURCING_METHOD_TO) return;

        // Skip already-processed lines
        var processed = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: lineIdx });
        var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: lineIdx });
        if (processed || linkedTo) return;

        var lineNum = lineIdx + 1;

        // 1. Item type must be Inventory or Assembly
        var itemType = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'itemtype', line: lineIdx });
        if (itemType && !ALLOWED_ITEM_TYPES[itemType]) {
            throw new Error('Line ' + lineNum + ': item type "' + itemType + '" is not supported for Transfer Order sourcing. Only Inventory Items and Assembly Items are supported.');
        }

        // 2. From Location must be set
        var fromLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: lineIdx });
        if (!fromLoc) {
            throw new Error('Line ' + lineNum + ': Source From Location is required for Transfer Order sourcing.');
        }

        // 3. From Location must not equal destination location (line or header)
        var lineDestLoc = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: lineIdx })
                       || rec.getValue({ fieldId: 'location' });
        if (String(fromLoc) === String(lineDestLoc)) {
            throw new Error('Line ' + lineNum + ': Source From Location cannot equal the destination Location.');
        }

        // 4. Conflicting native sourcing fields
        var isSpecialOrder = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'createpo', line: lineIdx });
        if (isSpecialOrder) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a line that also has Special Order / Drop Ship configured. Clear the Create PO field first.');
        }
        var poVendor = rec.getSublistValue({ sublistId: SUBLIST, fieldId: 'povendor', line: lineIdx });
        if (poVendor) {
            throw new Error('Line ' + lineNum + ': cannot use Transfer Order sourcing on a line with a PO Vendor populated.');
        }
    }

    function blockIfActiveLinkedTOs(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        var blockingLines = [];

        for (var i = 0; i < lineCount; i++) {
            var linkedTo = rec.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            if (!linkedTo) continue;

            try {
                var toStatus = search.lookupFields({
                    type: record.Type.TRANSFER_ORDER,
                    id: linkedTo,
                    columns: ['status', 'tranid']
                });
                var statusVal = toStatus.status && toStatus.status[0] ? toStatus.status[0].value : '';
                if (ACTIVE_TO_STATUSES[statusVal]) {
                    blockingLines.push((i + 1) + ' (' + (toStatus.tranid || ('TO#' + linkedTo)) + ')');
                }
            } catch (e) {
                log.error('blockIfActiveLinkedTOs:lookup failed', e);
            }
        }

        if (blockingLines.length) {
            throw new Error('Cannot close/cancel this SO: the following lines have active Transfer Orders that must be cancelled or operationally reversed first: ' + blockingLines.join(', '));
        }
    }

    function cleanupCopiedLines(rec) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST });
        for (var i = 0; i < lineCount; i++) {
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i, value: '' });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i, value: false });
            rec.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: i, value: '' });
        }
    }

    // ---------- afterSubmit: the sourcing engine ----------

    function runSourcingEngine(so) {
        var soId = so.id;
        var tranId = so.getValue({ fieldId: 'tranid' }) || '';
        var subsidiary = so.getValue({ fieldId: 'subsidiary' });
        var headerLocation = so.getValue({ fieldId: 'location' });

        log.debug('engine:start', { soId: soId, tranId: tranId });

        // Step 1: collect qualifying lines
        var qualifyingLines = collectQualifyingLines(so, headerLocation);
        if (!qualifyingLines.length) {
            log.debug('engine:noQualifyingLines', { soId: soId });
            return;
        }

        log.debug('engine:qualifyingLines', { count: qualifyingLines.length });

        // Step 2: recheck availability per line (point-in-time recheck)
        var checkedLines = recheckAvailability(qualifyingLines);

        // Step 3: group survivors by From Location
        var groups = {};
        var skippedLines = [];
        checkedLines.forEach(function (line) {
            if (line.skip) {
                skippedLines.push(line);
            } else {
                if (!groups[line.fromLoc]) groups[line.fromLoc] = [];
                groups[line.fromLoc].push(line);
            }
        });

        // Step 4: create one TO per From Location group
        var successResults = []; // { lineIdx, toId }
        var failedResults = [];  // { lineIdx, error }

        Object.keys(groups).forEach(function (fromLocId) {
            var groupLines = groups[fromLocId];
            try {
                var toId = createTransferOrder(subsidiary, fromLocId, headerLocation, groupLines, tranId, soId);
                groupLines.forEach(function (line) {
                    successResults.push({ lineIdx: line.lineIdx, toId: toId });
                });
                log.audit('engine:toCreated', { fromLocId: fromLocId, toId: toId, lineCount: groupLines.length });
            } catch (e) {
                log.error('engine:toCreateFailed', { fromLocId: fromLocId, error: e.message });
                groupLines.forEach(function (line) {
                    failedResults.push({ lineIdx: line.lineIdx, error: 'TO creation failed: ' + e.message });
                });
            }
        });

        // Step 5: single writeback pass to the SO
        writebackResults(soId, successResults, failedResults, skippedLines);

        log.audit('engine:done', {
            soId: soId,
            successLines: successResults.length,
            failedLines: failedResults.length,
            skippedLines: skippedLines.length
        });
    }

    function collectQualifyingLines(so, headerLocation) {
        var lineCount = so.getLineCount({ sublistId: SUBLIST });
        var lines = [];

        for (var i = 0; i < lineCount; i++) {
            var method = String(so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.METHOD, line: i }) || '');
            if (method !== SOURCING_METHOD_TO) continue;

            var processed = so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: i });
            var linkedTo = so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: i });
            if (processed || linkedTo) continue;

            var fromLoc = so.getSublistValue({ sublistId: SUBLIST, fieldId: FIELD.FROM_LOC, line: i });
            if (!fromLoc) continue;

            var item = so.getSublistValue({ sublistId: SUBLIST, fieldId: 'item', line: i });
            if (!item) continue;

            // Qty Required: backordered first, fallback to line quantity
            var bo = parseFloat(so.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantitybackordered', line: i }) || '0');
            var qty = parseFloat(so.getSublistValue({ sublistId: SUBLIST, fieldId: 'quantity', line: i }) || '0');
            var qtyRequired = bo > 0 ? bo : qty;

            if (qtyRequired <= 0) continue;

            var lineDestLoc = so.getSublistValue({ sublistId: SUBLIST, fieldId: 'location', line: i }) || headerLocation;
            var units = so.getSublistValue({ sublistId: SUBLIST, fieldId: 'units', line: i });

            lines.push({
                lineIdx: i,
                lineNum: i + 1,
                item: item,
                fromLoc: fromLoc,
                destLoc: lineDestLoc,
                qtyRequired: qtyRequired,
                units: units
            });
        }
        return lines;
    }

    function recheckAvailability(lines) {
        if (!lines.length) return lines;

        // Batch lookup: group requested (item, fromLoc) pairs
        var pairs = {};
        lines.forEach(function (line) {
            var key = line.item + '|' + line.fromLoc;
            if (!pairs[key]) pairs[key] = { item: line.item, location: line.fromLoc };
        });
        var pairList = Object.keys(pairs).map(function (k) { return pairs[k]; });

        // Run one inventorybalance search per (item, location) — for ~100 lines / 5 locations
        // this is at most ~100 lookups but typically far fewer. Within governance.
        var availMap = {};
        pairList.forEach(function (p) {
            try {
                var s = search.create({
                    type: 'inventorybalance',
                    filters: [
                        ['item', 'anyof', p.item],
                        'AND',
                        ['location', 'anyof', p.location]
                    ],
                    columns: [search.createColumn({ name: 'available' })]
                });
                var avail = 0;
                s.run().each(function (r) {
                    avail = parseFloat(r.getValue({ name: 'available' }) || '0');
                    return false; // first row only
                });
                availMap[p.item + '|' + p.location] = avail;
            } catch (e) {
                log.error('recheckAvailability:lookupFailed', { item: p.item, loc: p.location, error: e.message });
                availMap[p.item + '|' + p.location] = 0;
            }
        });

        return lines.map(function (line) {
            var avail = availMap[line.item + '|' + line.fromLoc] || 0;
            if (avail < line.qtyRequired) {
                line.skip = true;
                line.error = 'Availability dropped: requested ' + line.qtyRequired + ', available ' + avail + ' at source location at time of TO creation.';
            }
            return line;
        });
    }

    function createTransferOrder(subsidiary, fromLocId, toLocId, groupLines, soTranId, soId) {
        var to = record.create({ type: record.Type.TRANSFER_ORDER, isDynamic: true });

        if (subsidiary) {
            to.setValue({ fieldId: 'subsidiary', value: subsidiary });
        }
        to.setValue({ fieldId: 'location', value: fromLocId });
        to.setValue({ fieldId: 'transferlocation', value: toLocId });
        to.setValue({ fieldId: 'memo', value: 'Auto-created from SO #' + (soTranId || soId) });

        // Use firmed so committed qty behavior is predictable
        try { to.setValue({ fieldId: 'orderstatus', value: 'A' }); } catch (e) { /* status not always scriptable */ }

        groupLines.forEach(function (line) {
            to.selectNewLine({ sublistId: 'item' });
            to.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: line.item });
            to.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: line.qtyRequired });
            if (line.units) {
                try { to.setCurrentSublistValue({ sublistId: 'item', fieldId: 'units', value: line.units }); } catch (e) {}
            }
            to.commitLine({ sublistId: 'item' });
        });

        var toId = to.save({ ignoreMandatoryFields: false });
        return toId;
    }

    function writebackResults(soId, successResults, failedResults, skippedLines) {
        if (!successResults.length && !failedResults.length && !skippedLines.length) return;

        // Load SO standard mode for line writes
        var so = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });

        // Success: set linked_to, processed=true, clear error
        successResults.forEach(function (s) {
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.LINKED_TO, line: s.lineIdx, value: s.toId });
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.PROCESSED, line: s.lineIdx, value: true });
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: s.lineIdx, value: '' });
        });

        // Failed (TO create errored): set error, leave processed=false so retry on next save
        failedResults.forEach(function (f) {
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: f.lineIdx, value: f.error });
        });

        // Skipped (availability drop): set error, leave processed=false
        skippedLines.forEach(function (line) {
            so.setSublistValue({ sublistId: SUBLIST, fieldId: FIELD.ERROR, line: line.lineIdx, value: line.error });
        });

        so.save({ ignoreMandatoryFields: true, enableSourcing: false });
    }

    return {
        beforeSubmit: beforeSubmit,
        afterSubmit: afterSubmit
    };
});
