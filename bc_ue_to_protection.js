/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 *
 * BC TO Protection User Event
 *
 * Deploys on the Transfer Order record. Blocks deletion of a TO when any
 * Sales Order line has it set in custcol_bc_linked_to.
 *
 * Why block (not warn): once a TO is deleted, the SO line's Linked TO field
 * points at a phantom record. The processed flag stays true, blocking
 * reprocessing, and the audit trail is broken. Forcing the Admin to use the
 * documented correction flow (open the SO, clear Linked TO + Processed +
 * Error, then delete the TO) keeps everything consistent.
 *
 * Edit operations on the TO are NOT blocked — only delete.
 */
define(['N/search', 'N/log'], function (search, log) {

    function beforeSubmit(context) {
        if (context.type !== context.UserEventType.DELETE) return;

        try {
            var toId = (context.oldRecord && context.oldRecord.id) ||
                       (context.newRecord && context.newRecord.id);
            if (!toId) return;

            var linkedSOs = findLinkedSalesOrders(toId);
            if (linkedSOs.length) {
                throw new Error(
                    'Cannot delete this Transfer Order: it is linked to the following Sales Order line(s): ' +
                    linkedSOs.join('; ') +
                    '. To delete this TO, an Administrator must first open each linked SO, ' +
                    'clear the Linked Transfer Order, Sourcing Processed, and Sourcing Error fields ' +
                    'on the affected line, and save the SO.'
                );
            }
        } catch (e) {
            log.error('TO protection beforeSubmit failed', e);
            throw e;
        }
    }

    function findLinkedSalesOrders(toId) {
        var refs = [];
        try {
            var s = search.create({
                type: 'salesorder',
                filters: [
                    ['custcol_bc_linked_to', 'anyof', toId],
                    'AND',
                    ['mainline', 'is', 'F']
                ],
                columns: [
                    search.createColumn({ name: 'tranid' }),
                    search.createColumn({ name: 'internalid' }),
                    search.createColumn({ name: 'line' })
                ]
            });

            s.run().each(function (r) {
                var tranid = r.getValue({ name: 'tranid' });
                var iid = r.getValue({ name: 'internalid' });
                var lineNum = r.getValue({ name: 'line' });
                var label = (tranid || ('SO#' + iid)) + (lineNum ? ' (line ' + lineNum + ')' : '');
                refs.push(label);
                return refs.length < 10; // cap output at 10
            });
        } catch (e) {
            log.error('findLinkedSalesOrders search failed', e);
        }
        return refs;
    }

    return { beforeSubmit: beforeSubmit };
});
