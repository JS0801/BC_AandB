/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 * @NModuleScope SameAccount
 *
 * Script ID:  customscript_bc_psv_pdf_sl
 * Deploy ID:  customdeploy_bc_psv_pdf_sl
 *
 * Params: taskId, action (preview | regenerate)
 */
define([
    'N/record',
    'N/render',
    'N/search',
    'N/file',
    'N/log',
    'N/url'
], (record, render, search, file, log, url) => {

    const PSV_RECORD_TYPE  = 'customrecord_bc_psv';
    const TEMPLATE_ID      = 'CUSTTMPL_118_11915859_SB1_110';
    const ROOT_FOLDER_NAME = 'PSV Reports';

    const onRequest = (context) => {
        const params = context.request.parameters;
        const action = params.action;
        const taskId = params.taskId;

        if (!taskId) {
            sendJson(context, false, 'Missing taskId parameter.');
            return;
        }

        try {
            if (action === 'preview') {
                handlePreview(context, taskId);
            } else if (action === 'regenerate') {
                handleRegenerate(context, taskId);
            } else {
                sendJson(context, false, 'Invalid action: ' + action);
            }
        } catch (e) {
            log.error('PSV Suitelet', 'Task ' + taskId + ': ' + e.message + '\n' + e.stack);

            try {
                const psvIds = findPsvTestsByTask(taskId);
                for (var i = 0; i < psvIds.length; i++) {
                    try {
                        record.submitFields({
                            type: PSV_RECORD_TYPE,
                            id: psvIds[i],
                            values: {
                                custrecord_bc_psv_pdf_error: new Date().toISOString() + ' — ' + e.message
                            }
                        });
                    } catch (inner) {
                        log.error('PSV Suitelet', 'Could not log error to PSV ' + psvIds[i] + ': ' + inner.message);
                    }
                }
                record.submitFields({
                    type: record.Type.TASK,
                    id: taskId,
                    values: {
                        custevent_psv_error_log: new Date().toISOString() + ' — ' + e.message
                    }
                });
            } catch (inner) {
                log.error('PSV Suitelet', 'Could not log error to Task: ' + inner.message);
            }

            sendJson(context, false, e.message);
        }
    };

    /* ---- PREVIEW ---- */
    const handlePreview = (context, taskId) => {
        const taskRec = record.load({ type: record.Type.TASK, id: taskId });
        const fileId  = taskRec.getValue({ fieldId: 'custevent_bc_psv_pdf' });

        if (!fileId) {
            context.response.write('No PDF has been generated for this Task yet.');
            return;
        }

        const pdfFile = file.load({ id: fileId });
        context.response.writeFile({ file: pdfFile, isInline: true });
    };

    /* ---- REGENERATE ---- */
    const handleRegenerate = (context, taskId) => {
        const taskRec   = record.load({ type: record.Type.TASK, id: taskId });
        const taskTitle = taskRec.getValue({ fieldId: 'title' }) || 'Untitled';

        const psvIds = findPsvTestsByTask(taskId);
        if (!psvIds || !psvIds.length) {
            const errorMsg = 'No PSV Test records linked to Task ' + taskId + '.';
            record.submitFields({
                type: record.Type.TASK,
                id: taskId,
                values: { custevent_psv_error_log: errorMsg }
            });
            sendJson(context, false, errorMsg);
            return;
        }

        const rootFolderId  = getOrCreateFolder(ROOT_FOLDER_NAME, null);
        const subFolderName = truncate('Task-' + taskId + ' - ' + taskTitle, 100);
        const subFolderId   = getOrCreateFolder(subFolderName, rootFolderId);

        // Detach old attachments before regenerating
        removeOldTaskAttachments(taskId);

        var createdIndividualFileIds = [];
        var errorMessages = [];
        var successCount = 0;

        for (var i = 0; i < psvIds.length; i++) {
            var psvId = psvIds[i];

            try {
                var psvRec = record.load({ type: PSV_RECORD_TYPE, id: psvId });

                // Render individual PDF
                var renderer = render.create();
                renderer.setTemplateByScriptId({ scriptId: TEMPLATE_ID });
                renderer.addRecord({ templateName: 'record', record: psvRec });
                var pdfFile = renderer.renderAsPdf();

                // Build file name – same WO# parsing as UE
                var woNum = psvRec.getText({ fieldId: 'custrecord_bc_psv_work_order' }) || 'NOWO';
                if (woNum && woNum.indexOf('#') !== -1) {
                    var parts = woNum.split('#');
                    woNum = parts[1] ? parts[1].trim() : woNum;
                }
                var now     = new Date();
                var dateStr = formatDateMMDDYYYY(now);
                var timeStr = String(now.getHours()).padStart(2, '0') +
                              String(now.getMinutes()).padStart(2, '0') +
                              String(now.getSeconds()).padStart(2, '0');

                pdfFile.name     = 'PSV_Report_' + sanitize(woNum) + '_' + psvId + '_' + dateStr + '_' + timeStr + '.pdf';
                pdfFile.folder   = subFolderId;
                pdfFile.isOnline = true;

                var fileId = pdfFile.save();
                createdIndividualFileIds.push(fileId);
                successCount++;

                // Update PSV record – clear any previous error
                record.submitFields({
                    type: PSV_RECORD_TYPE,
                    id: psvId,
                    values: {
                        custrecord_bc_psv_pdf_file_id: fileId,
                        custrecord_bc_psv_pdf_error: ''
                    }
                });

                // Attach individual PDF to Task
                record.attach({
                    record: { type: 'file', id: fileId },
                    to:     { type: 'task', id: taskId }
                });

                log.audit('PSV Regen', 'Generated PDF for PSV ' + psvId + ', fileId=' + fileId);

            } catch (psvErr) {
                errorMessages.push('PSV ' + psvId + ': ' + psvErr.message);
                log.error('PSV Regen Error', 'PSV ' + psvId + ': ' + psvErr.message);

                try {
                    record.submitFields({
                        type: PSV_RECORD_TYPE,
                        id: psvId,
                        values: {
                            custrecord_bc_psv_pdf_error: new Date().toISOString() + ' - ' + psvErr.message
                        }
                    });
                } catch (innerErr) {
                    log.error('PSV Regen Error', 'Could not update PSV error for ' + psvId + ': ' + innerErr.message);
                }
            }
        }

        // Merge all individual PDFs into one
        var mergedFileId = '';
        if (createdIndividualFileIds.length > 0) {
            mergedFileId = createMergedPsvPdf(createdIndividualFileIds, taskId, subFolderId);
        }

        if (mergedFileId) {
            record.attach({
                record: { type: 'file', id: mergedFileId },
                to:     { type: 'task', id: taskId }
            });
        }

        // Update Task record
        record.submitFields({
            type: record.Type.TASK,
            id: taskId,
            values: {
                custevent_bc_psv_pdf_generated: successCount > 0,
                custevent_bc_psv_folder_id: subFolderId,
                custevent_bc_psv_pdf: mergedFileId || '',
                custevent_psv_error_log: errorMessages.join('\n')
            }
        });

        log.audit('PSV Regen', 'Task ' + taskId + ': ' + successCount + ' PDF(s) regenerated. Merged fileId=' + mergedFileId);

        sendJson(context, true, 'PDF regenerated successfully.', mergedFileId || createdIndividualFileIds[0]);
    };

    /* ---- HELPERS ---- */

    const createMergedPsvPdf = (fileIds, taskId, folderId) => {
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
            // Escape & to &amp; so the XML is valid for the BFO renderer
            var escapedUrl = rawUrl.replace(/&/g, '&amp;');
            xmlContent += '<pdf src="' + escapedUrl + '"/>';
        }

        xmlContent += '</pdfset>';

        log.debug('PSV Merged XML', xmlContent);

        var mergedPdfObj     = render.xmlToPdf({ xmlString: xmlContent });
        mergedPdfObj.name    = 'PSV_Merged_Task_' + taskId + '.pdf';
        mergedPdfObj.folder  = folderId;
        mergedPdfObj.isOnline = true;

        var mergedFileId = mergedPdfObj.save();
        log.audit('PSV Regen', 'Merged PDF created, fileId=' + mergedFileId);
        return mergedFileId;
    };

    const removeOldTaskAttachments = (taskId) => {
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

            var oldFileIds = [];
            for (var i = 0; i < taskFileSearch.length; i++) {
                var oldFileId = taskFileSearch[i].getValue({ name: 'internalid', join: 'file' });
                if (oldFileId) oldFileIds.push(oldFileId);
            }

            for (var j = 0; j < oldFileIds.length; j++) {
                try {
                    record.detach({
                        record: { type: 'file', id: oldFileIds[j] },
                        from:   { type: 'task', id: taskId }
                    });
                    log.audit('PSV Regen', 'Detached old file ' + oldFileIds[j] + ' from Task ' + taskId);
                } catch (detachErr) {
                    log.error('PSV Regen Detach Error', 'File ' + oldFileIds[j] + ': ' + detachErr.message);
                }
            }
        } catch (e) {
            log.error('PSV Regen', 'Error removing old attachments from Task ' + taskId + ': ' + e.message);
        }
    };

    const findPsvTestsByTask = (taskId) => {
        const results = search.create({
            type: PSV_RECORD_TYPE,
            filters: [['custrecord_bc_psv_task', 'anyof', taskId]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1000 });
        var ids = [];
        for (var i = 0; i < results.length; i++) ids.push(results[i].id);
        return ids;
    };

    const sendJson = (context, success, message, fileId) => {
        const payload = { success: success, message: message };
        if (fileId) payload.fileId = fileId;
        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
        context.response.write(JSON.stringify(payload));
    };

    const getOrCreateFolder = (folderName, parentId) => {
        const filters = [['name', 'is', folderName]];
        if (parentId) {
            filters.push('AND', ['parent', 'anyof', parentId]);
        } else {
            filters.push('AND', ['parent', 'anyof', '@NONE@']);
        }
        const results = search.create({
            type: search.Type.FOLDER, filters, columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        if (results.length) return results[0].id;
        const folderRec = record.create({ type: record.Type.FOLDER });
        folderRec.setValue({ fieldId: 'name', value: folderName });
        if (parentId) folderRec.setValue({ fieldId: 'parent', value: parentId });
        return folderRec.save();
    };

    const formatDateMMDDYYYY = (d) => {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return mm + dd + d.getFullYear();
    };

    const sanitize = (str) => String(str).replace(/[^a-zA-Z0-9_-]/g, '_');
    const truncate  = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

    return { onRequest };
});