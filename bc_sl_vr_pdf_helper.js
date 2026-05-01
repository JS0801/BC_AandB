/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Backs the Preview / Regenerate buttons added to the Task record by
 * bc_vr_pdf_gen_ue.js (beforeLoad).
 *
 * Script ID:    customscript_bc_sl_vr_pdf_helper
 * Deployment:   customdeploy_bc_sl_vr_pdf_helper
 *
 * URL params:
 *   taskId  - internal id of the Task record
 *   action  - 'preview' (default) or 'regenerate'
 *
 * preview     - Streams the merged VR PDF stored in
 *               custevent_bc_vr_pdf_generated to the browser inline.
 * regenerate  - Re-runs the full PDF generation pipeline (the same logic
 *               the User Event uses on Task close), then returns a JSON
 *               { success, message } payload that the client script
 *               renders in its overlay.
 */
define([
    'N/record',
    'N/render',
    'N/search',
    'N/file',
    'N/log',
    'N/url'
], function (record, render, search, file, log, url) {

    // ---------------------------------------------------------------------
    // CONFIG - must match UE / MR
    // ---------------------------------------------------------------------
    var VR_RECORD_TYPE     = 'customrecord_bc_vr';
    var TEMPLATE_ID        = 'CUSTTMPL_BC_VALVE_REPAIR_PDFHTML_TEMPLATE';
    var ROOT_FOLDER_ID     = 3483;
    var VR_TASK_LINK_FIELD = 'custrecord_bc_vr_ab_control_num';

    // =====================================================================
    // ENTRY POINT
    // =====================================================================
    function onRequest(context) {
        var req    = context.request;
        var res    = context.response;
        var taskId = req.parameters.taskId;
        var action = (req.parameters.action || 'preview').toLowerCase();

        if (!taskId) {
            return writeJson(res, {
                success: false,
                message: 'Missing required parameter: taskId'
            });
        }

        try {
            if (action === 'preview') {
                handlePreview(taskId, res);
            } else if (action === 'regenerate') {
                handleRegenerate(taskId, res);
            } else {
                writeJson(res, {
                    success: false,
                    message: 'Unknown action: ' + action
                });
            }
        } catch (e) {
            log.error('VR PDF Suitelet',
                'Task ' + taskId + ' / ' + action + ': ' +
                e.message + (e.stack ? '\n' + e.stack : ''));

            // Preview goes to browser tab and uses HTML; Regenerate is
            // called via AJAX and expects JSON.
            if (action === 'regenerate') {
                writeJson(res, {
                    success: false,
                    message: e.message || String(e)
                });
            } else {
                res.write({
                    output: '<h2>Error</h2><pre>' +
                            (e.message || String(e)) +
                            '</pre><p><a href="javascript:history.back()">Back</a></p>'
                });
            }
        }
    }

    // =====================================================================
    // PREVIEW - stream merged PDF inline
    // =====================================================================
    function handlePreview(taskId, res) {
        var lookup = search.lookupFields({
            type:    record.Type.TASK,
            id:      taskId,
            columns: ['custevent_bc_vr_pdf_generated']
        });

        var fileId = lookup.custevent_bc_vr_pdf_generated;
        log.debug('fileId', fileId)
        if (!fileId) {
            res.write({
                output: '<h2>No PDF available</h2>' +
                        '<p>No merged VR PDF has been generated for Task ' +
                        taskId + ' yet.</p>' +
                        '<p><a href="javascript:history.back()">Back</a></p>'
            });
            return;
        }

        var pdf = file.load({ id: fileId });

        res.writeFile({
            file:     pdf,
            isInline: true
        });
    }

    // =====================================================================
    // REGENERATE - re-run full pipeline, return JSON
    // =====================================================================
    function handleRegenerate(taskId, res) {
        var taskLookup = search.lookupFields({
            type:    record.Type.TASK,
            id:      taskId,
            columns: ['title']
        });
        var taskTitle = taskLookup.title || 'Untitled';

        log.audit('VR PDF Suitelet',
            'Regenerate requested for Task ' + taskId);

        var summary = regenerateForTask(taskId, taskTitle);

        if (summary.successCount === 0) {
            return writeJson(res, {
                success: false,
                message: summary.errors && summary.errors.length
                    ? 'No PDFs generated. ' + summary.errors.join(' | ')
                    : 'No Valve Repair records linked to this Task.'
            });
        }

        var msg = summary.successCount +
                  ' Valve Repair PDF(s) generated' +
                  (summary.errors && summary.errors.length
                      ? '; ' + summary.errors.length + ' record(s) had errors.'
                      : '.');

        writeJson(res, {
            success:      true,
            message:      msg,
            successCount: summary.successCount,
            mergedFileId: summary.mergedFileId,
            errors:       summary.errors
        });
    }

    function writeJson(res, payload) {
        res.setHeader({ name: 'Content-Type', value: 'application/json' });
        res.write({ output: JSON.stringify(payload) });
    }

    // =====================================================================
    // CORE: full regeneration pipeline (same as UE afterSubmit)
    // =====================================================================
    function regenerateForTask(taskId, taskTitle) {
        var vrIds = findValveRepairsByTask(taskId);

        if (!vrIds || !vrIds.length) {
            record.submitFields({
                type: record.Type.TASK,
                id:   taskId,
                values: {
                    custevent_bc_valve_error_log:
                        'No Valve Repair records linked to Task ' + taskId + '.'
                }
            });
            return { successCount: 0, mergedFileId: '', errors: ['No VR records linked.'] };
        }

        var subFolderName = truncate('Task-' + taskId + ' - ' + taskTitle, 100);
        var subFolderId   = getOrCreateFolder(subFolderName, ROOT_FOLDER_ID);

        removeOldTaskAttachments(taskId);

        var createdIndividualFileIds = [];
        var errorMessages            = [];
        var successCount             = 0;

        for (var i = 0; i < vrIds.length; i++) {
            var vrId = vrIds[i];

            try {
                var vrRec = record.load({ type: VR_RECORD_TYPE, id: vrId });

                var pdfFile = renderVrPdf(vrRec);

                var woTextRaw = vrRec.getText({
                    fieldId: 'custrecord_bc_vr_work_order'
                }) || 'NOWO';
                var assetTextRaw = vrRec.getText({
                    fieldId: 'custrecord_bc_vr_asset'
                }) || ('VR' + vrId);

                var woNum = woTextRaw;
                if (woNum && woNum.indexOf('#') !== -1) {
                    var parts = woNum.split('#');
                    woNum = parts[1] ? parts[1].trim() : woNum;
                }

                var dateStr  = formatDateMMDDYYYY(new Date());
                var fileName = 'VR_Report_' +
                               sanitize(woNum) + '_' +
                               sanitize(assetTextRaw) + '_' +
                               dateStr + '.pdf';

                pdfFile.name     = fileName;
                pdfFile.folder   = subFolderId;
                pdfFile.isOnline = true;

                var fileId = pdfFile.save();
                createdIndividualFileIds.push(fileId);
                successCount++;

                record.submitFields({
                    type: VR_RECORD_TYPE,
                    id:   vrId,
                    values: {
                        custrecord_bc_vr_pdf_file_id: fileId,
                        custrecord_bc_vr_pdf_error:   ''
                    }
                });

                record.attach({
                    record: { type: 'file', id: fileId },
                    to:     { type: 'task', id: taskId }
                });

                log.audit('VR PDF Suitelet',
                    'Generated PDF for VR ' + vrId + ', fileId=' + fileId);

            } catch (vrErr) {
                var msg = vrErr && vrErr.message ? vrErr.message : String(vrErr);
                errorMessages.push('VR ' + vrId + ': ' + msg);
                log.error('VR PDF Suitelet Error',
                    'VR ' + vrId + ': ' + msg);

                try {
                    record.submitFields({
                        type: VR_RECORD_TYPE,
                        id:   vrId,
                        values: {
                            custrecord_bc_vr_pdf_error:
                                new Date().toISOString() +
                                ' - Manual Regenerate - ' + msg
                        }
                    });
                } catch (innerErr) {
                    log.error('VR PDF Suitelet Error',
                        'Could not update VR error: ' + innerErr.message);
                }
            }
        }

        var mergedFileId = '';
        if (createdIndividualFileIds.length > 0) {
            mergedFileId = createMergedVrPdf(
                createdIndividualFileIds, taskId, subFolderId
            );
        }

        if (mergedFileId) {
            record.attach({
                record: { type: 'file', id: mergedFileId },
                to:     { type: 'task', id: taskId }
            });
        }

        record.submitFields({
            type: record.Type.TASK,
            id:   taskId,
            values: {
                custevent_bc_vr_folder_id:     subFolderId,
                custevent_bc_vr_pdf_generated: mergedFileId || '',
                custevent_bc_valve_error_log:  errorMessages.join('\n')
            }
        });

        return {
            successCount: successCount,
            mergedFileId: mergedFileId,
            errors:       errorMessages
        };
    }

    // =====================================================================
    // HELPERS
    // =====================================================================
    function findValveRepairsByTask(taskId) {
        var results = search.create({
            type: VR_RECORD_TYPE,
            filters: [
                [VR_TASK_LINK_FIELD, 'anyof', taskId],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1000 });

        var ids = [];
        for (var i = 0; i < results.length; i++) ids.push(results[i].id);
        return ids;
    }

    function renderVrPdf(vrRec) {
        var renderer = render.create();
        renderer.setTemplateByScriptId({ scriptId: TEMPLATE_ID });
        renderer.addRecord({ templateName: 'record', record: vrRec });
        return renderer.renderAsPdf();
    }

    function createMergedVrPdf(fileIds, taskId, folderId) {
        var domain = url.resolveDomain({ hostType: url.HostType.APPLICATION });

        var xmlContent = '<?xml version="1.0"?>\n';
        xmlContent += '<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">\n';
        xmlContent += '<pdfset>';

        for (var i = 0; i < fileIds.length; i++) {
            var loadedPdf = file.load({ id: fileIds[i] });
            var rawUrl = loadedPdf.url;
            if (rawUrl.indexOf('http') !== 0) {
                rawUrl = 'https://' + domain + rawUrl;
            }
            var escapedUrl = rawUrl.replace(/&/g, '&amp;');
            xmlContent += '<pdf src="' + escapedUrl + '"/>';
        }

        xmlContent += '</pdfset>';

        var mergedPdfObj      = render.xmlToPdf({ xmlString: xmlContent });
        mergedPdfObj.name     = 'VR_Merged_Task_' + taskId + '.pdf';
        mergedPdfObj.folder   = folderId;
        mergedPdfObj.isOnline = true;

        var mergedFileId = mergedPdfObj.save();
        log.audit('VR PDF Suitelet',
            'Merged PDF created, fileId=' + mergedFileId);
        return mergedFileId;
    }

    function removeOldTaskAttachments(taskId) {
        try {
            var taskFileSearch = search.create({
                type: 'task',
                filters: [
                    ['internalid', 'anyof', taskId],
                    'AND',
                    ['file.internalid', 'noneof', '@NONE@']
                ],
                columns: [
                    search.createColumn({ name: 'internalid', join: 'file' })
                ]
            }).run().getRange({ start: 0, end: 1000 });

            for (var i = 0; i < taskFileSearch.length; i++) {
                var oldFileId = taskFileSearch[i].getValue({
                    name: 'internalid', join: 'file'
                });
                if (!oldFileId) continue;

                try {
                    record.detach({
                        record: { type: 'file', id: oldFileId },
                        from:   { type: 'task', id: taskId }
                    });
                } catch (detachErr) {
                    log.error('VR PDF Suitelet Detach Error',
                        'File ' + oldFileId + ': ' + detachErr.message);
                }
            }
        } catch (e) {
            log.error('VR PDF Suitelet',
                'Error removing old attachments from Task ' + taskId +
                ': ' + e.message);
        }
    }

    function getOrCreateFolder(folderName, parentId) {
        var filters = [['name', 'is', folderName]];
        if (parentId) {
            filters.push('AND', ['parent', 'anyof', parentId]);
        } else {
            filters.push('AND', ['parent', 'anyof', '@NONE@']);
        }

        var results = search.create({
            type:    search.Type.FOLDER,
            filters: filters,
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        if (results.length) return results[0].id;

        var folderRec = record.create({ type: record.Type.FOLDER });
        folderRec.setValue({ fieldId: 'name', value: folderName });
        if (parentId) folderRec.setValue({ fieldId: 'parent', value: parentId });
        return folderRec.save();
    }

    function formatDateMMDDYYYY(d) {
        var mm   = String(d.getMonth() + 1).padStart(2, '0');
        var dd   = String(d.getDate()).padStart(2, '0');
        var yyyy = d.getFullYear();
        return mm + dd + yyyy;
    }

    function sanitize(str) {
        return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    }

    function truncate(str, maxLen) {
        return str.length > maxLen ? str.substring(0, maxLen) : str;
    }

    return { onRequest: onRequest };
});