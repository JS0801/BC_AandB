/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 */
define(['N/search', 'N/log'], function (search, log) {

    var HEADER_FIELD = 'custbody_bc_special_buy_item';
    var LINE_FIELD = 'custcol_bc_special_buy_item';
    var SUBLIST_ID = 'item';

    function hasLinkedPurchaseOrders(createdFromId) {
        if (!createdFromId) {
            return false;
        }

        var purchaseorderSearchObj = search.create({
            type: 'purchaseorder',
            settings: [{ name: 'consolidationtype', value: 'ACCTTYPE' }],
            filters: [
                ['type', 'anyof', 'PurchOrd'],
                'AND',
                ['mainline', 'is', 'T'],
                'AND',
                ['createdfrom', 'anyof', createdFromId]
            ],
            columns: [
                search.createColumn({ name: 'internalid', label: 'Internal ID' })
            ]
        });

        var searchResultCount = purchaseorderSearchObj.runPaged().count;
        log.debug('purchaseorderSearchObj result count', searchResultCount);

        return searchResultCount > 0;
    }

    function disableHeaderField(context) {
        try {
            var fieldObj = context.currentRecord.getField({
                fieldId: HEADER_FIELD
            });

            if (fieldObj) {
                fieldObj.isDisabled = true;
            }
        } catch (e) {
            log.error('disableHeaderField Error', e);
        }
    }

    function isHeaderDisabled(context) {
        try {
            var fieldObj = context.currentRecord.getField({
                fieldId: HEADER_FIELD
            });

            return fieldObj && fieldObj.isDisabled === true;
        } catch (e) {
            log.error('isHeaderDisabled Error', e);
            return false;
        }
    }

    function updateAllLines(rec, headerValue) {
        var lineCount = rec.getLineCount({ sublistId: SUBLIST_ID }) || 0;
        var i;

        for (i = 0; i < lineCount; i++) {
            rec.selectLine({
                sublistId: SUBLIST_ID,
                line: i
            });

            rec.setCurrentSublistValue({
                sublistId: SUBLIST_ID,
                fieldId: LINE_FIELD,
                value: !!headerValue,
                ignoreFieldChange: true
            });

            rec.commitLine({
                sublistId: SUBLIST_ID
            });
        }
    }

    function pageInit(context) {
        try {
            var rec = context.currentRecord;
            var createdFromId = rec.getValue({ fieldId: 'createdfrom' });

            if (!createdFromId) {
                return;
            }

            var hasResult = hasLinkedPurchaseOrders(createdFromId);

            if (hasResult) {
                disableHeaderField(context);
                log.debug('pageInit', 'Matching PO exists. Header field disabled, client processing skipped.');
            }
        } catch (e) {
            log.error('pageInit Error', e);
        }
    }

    function fieldChanged(context) {
        try {
            var rec = context.currentRecord;

            if (isHeaderDisabled(context)) {
                return;
            }

            if (context.fieldId === HEADER_FIELD) {
                var headerValue = rec.getValue({ fieldId: HEADER_FIELD });
                updateAllLines(rec, headerValue);
            }
        } catch (e) {
            log.error('fieldChanged Error', e);
        }
    }

    function postSourcing(context) {
        try {
            var rec = context.currentRecord;

            if (isHeaderDisabled(context)) {
                return;
            }

            if (context.sublistId === SUBLIST_ID && context.fieldId === 'item') {
                var itemValue = rec.getCurrentSublistValue({
                    sublistId: SUBLIST_ID,
                    fieldId: 'item'
                });

                if (itemValue) {
                    var headerValue = rec.getValue({ fieldId: HEADER_FIELD });

                    rec.setCurrentSublistValue({
                        sublistId: SUBLIST_ID,
                        fieldId: LINE_FIELD,
                        value: !!headerValue,
                        ignoreFieldChange: true
                    });
                }
            }
        } catch (e) {
            log.error('postSourcing Error', e);
        }
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged,
        postSourcing: postSourcing
    };
});
