/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define([
    'N/record',
    'N/render',
    'N/search',
    'N/file',
    'N/log',
    'N/format',
    'N/url',
    'N/xml'
], function (record, render, search, file, log, format, url, xml) {

    // ---------------------------------------------------------------------
    // CONFIG
    // ---------------------------------------------------------------------
    var VR_RECORD_TYPE     = 'customrecord_bc_vr';
    var TEMPLATE_ID        = 'custtmpl_bc_valve_repair_pdfhtml_template';
    var ROOT_FOLDER_ID     = 3483;            // "VR Reports" root folder
    var CLOSED_STATUS      = 'COMPLETE';      // Task status code for Closed
    var VR_TASK_LINK_FIELD = 'custrecord_bc_vr_ab_control_num';

    // Suitelet that backs the Preview / Regenerate buttons
    var SUITELET_SCRIPT = 'customscript_bc_sl_vr_pdf_helper';
    var SUITELET_DEPLOY = 'customdeploy_bc_sl_vr_pdf_helper';

    // =====================================================================
    // BEFORE LOAD - add Preview / Regenerate buttons in View mode
    // =====================================================================
    function beforeLoad(context) {
        if (context.type !== context.UserEventType.VIEW) return;

        var taskRec = context.newRecord;
        var taskId  = taskRec.id;
        var fileId  = taskRec.getValue({ fieldId: 'custevent_bc_vr_pdf_generated' });

        var suiteletUrl = url.resolveScript({
            scriptId:     SUITELET_SCRIPT,
            deploymentId: SUITELET_DEPLOY,
            params:       { taskId: taskId }
        });

        if (fileId) {
            var previewUrl = suiteletUrl + '&action=preview';
            context.form.addButton({
                id:           'custpage_btn_preview_vr_pdf',
                label:        'Preview VR PDF',
                functionName: "bcVrPreview('" + previewUrl + "')"
            });
        }

        var regenUrl = suiteletUrl + '&action=regenerate';
        context.form.addButton({
            id:           'custpage_btn_regen_vr_pdf',
            label:        'Regenerate VR PDF',
            functionName: "bcVrRegenerate('" + regenUrl + "')"
        });

        context.form.clientScriptModulePath = './bc_vr_pdf_cs.js';
    }

    // =====================================================================
    // AFTER SUBMIT - generate PDFs on Task close
    // =====================================================================
    function afterSubmit(context) {
        // Only run on create/edit
        if (
            context.type !== context.UserEventType.CREATE &&
            context.type !== context.UserEventType.EDIT
        ) {
            return;
        }

        var taskRec   = context.newRecord;
        var newStatus = taskRec.getValue({ fieldId: 'status' });

        // Must be Closed/Complete to proceed
        if (newStatus !== CLOSED_STATUS) return;

        // Status-transition guard: only fire when Task is moving INTO
        // Closed for the first time on this save. If it was already Closed
        // before this edit, do nothing (prevents re-runs on every later
        // edit of an already-closed Task). UC-003 (re-close) still works
        // because Task moves Open -> Closed on the re-close save.
        if (context.type === context.UserEventType.EDIT) {
            var oldRec    = context.oldRecord;
            var oldStatus = oldRec.getValue({ fieldId: 'status' });
            if (oldStatus === CLOSED_STATUS) //return;
        }

        var taskId    = taskRec.id;
        var taskTitle = taskRec.getValue({ fieldId: 'title' }) || 'Untitled';

        try {
            // -----------------------------------------------------------------
            // 1) Find all Valve Repair records linked to this Task.
            // -----------------------------------------------------------------
            var vrIds = findLinkedValveRepairs(taskId);

            if (!vrIds || !vrIds.length) {
                record.submitFields({
                    type: record.Type.TASK,
                    id:   taskId,
                    values: {
                        custevent_bc_valve_error_log:
                            'No Valve Repair records linked to Task ' + taskId + '.'
                    },
                    options: { ignoreMandatoryFields: true }
                });
                log.error('VR PDF', 'No Valve Repair records linked to Task ' + taskId);
                return;
            }

            // -----------------------------------------------------------------
            // 2) Resolve / create the Task sub-folder under VR Reports root.
            // -----------------------------------------------------------------
            var subFolderName = truncate('Task-' + taskId + ' - ' + taskTitle, 100);
            var subFolderId   = getOrCreateFolder(subFolderName, ROOT_FOLDER_ID);

            // -----------------------------------------------------------------
            // 3) Detach any existing PDF attachments from this Task so the
            //    re-close lifecycle (UC-003) doesn't pile up old versions.
            // -----------------------------------------------------------------
            removeOldTaskAttachments(taskId);

            // -----------------------------------------------------------------
            // 4) Loop each VR record - render, save, attach.
            // -----------------------------------------------------------------
            var createdIndividualFileIds = [];
            var errorMessages            = [];
            var successCount             = 0;

            for (var i = 0; i < vrIds.length; i++) {
                var vrId = vrIds[i];

                try {
                    var vrRec = record.load({
                        type: VR_RECORD_TYPE,
                        id:   vrId
                    });

                    var pdfFile = renderVrPdf(vrRec);

                    // Filename: VR_Report_[WO#]_[AssetNum]_[MMDDYYYY].pdf
                    var woTextRaw = vrRec.getText({
                        fieldId: 'custrecord_bc_vr_work_order'
                    }) || 'NOWO';
                    var assetTextRaw = vrRec.getText({
                        fieldId: 'custrecord_bc_vr_asset'
                    }) || ('VR' + vrId);

                    // If WO text contains a "#" (e.g. "Case #12345"),
                    // strip the prefix and keep just the number.
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
                    pdfFile.isOnline = true; // required for pdfset merge

                    var fileId = pdfFile.save();
                    createdIndividualFileIds.push(fileId);
                    successCount++;

                    record.submitFields({
                        type: VR_RECORD_TYPE,
                        id:   vrId,
                        values: {
                            custrecord_bc_vr_pdf_file_id: fileId,
                            custrecord_bc_vr_pdf_error:   ''
                        },
                        options: { ignoreMandatoryFields: true }
                    });

                    record.attach({
                        record: { type: 'file', id: fileId },
                        to:     { type: 'task', id: taskId }
                    });

                    log.audit(
                        'VR PDF',
                        'Generated individual PDF for VR ' + vrId +
                        ', fileId=' + fileId
                    );

                } catch (perRecordErr) {
                    var msg = perRecordErr && perRecordErr.message
                        ? perRecordErr.message
                        : String(perRecordErr);

                    errorMessages.push('VR ' + vrId + ': ' + msg);

                    log.error(
                        'VR PDF Error',
                        'VR ' + vrId + ': ' + msg
                    );

                    try {
                        record.submitFields({
                            type: VR_RECORD_TYPE,
                            id:   vrId,
                            values: {
                                custrecord_bc_vr_pdf_error:
                                    new Date().toISOString() + ' - ' + msg
                            },
                            options: { ignoreMandatoryFields: true }
                        });
                    } catch (innerErr) {
                        log.error(
                            'VR PDF Error',
                            'Could not update VR error for ' + vrId +
                            ': ' + innerErr.message
                        );
                    }
                }
            }

            // -----------------------------------------------------------------
            // 5) Build merged PDF combining all per-VR PDFs (if any succeeded).
            // -----------------------------------------------------------------
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

            // -----------------------------------------------------------------
            // 6) Final Task field write - flag, folder, merged file, errors.
            // -----------------------------------------------------------------
            record.submitFields({
                type: record.Type.TASK,
                id:   taskId,
                values: {
                    custbody_bc_vr_folder_id:     subFolderId,
                    custevent_bc_vr_pdf_generated:           mergedFileId || '',
                    custevent_bc_valve_error_log:     errorMessages.join('\n')
                },
                options: { ignoreMandatoryFields: true }
            });

            log.audit(
                'VR PDF',
                'Task ' + taskId + ': ' + successCount +
                ' individual PDF(s) generated. Merged fileId=' + mergedFileId
            );

        } catch (e) {
            log.error(
                'VR PDF Error',
                'Task ' + taskId + ': ' + e.message +
                (e.stack ? '\n' + e.stack : '')
            );

            try {
                record.submitFields({
                    type: record.Type.TASK,
                    id:   taskId,
                    values: {
                        custevent_bc_valve_error_log:
                            new Date().toISOString() + ' - ' + e.message
                    },
                    options: { ignoreMandatoryFields: true }
                });
            } catch (inner) {
                log.error(
                    'VR PDF Error',
                    'Could not log task error: ' + inner.message
                );
            }
        }
    }

    // =====================================================================
    // HELPERS
    // =====================================================================
    function findLinkedValveRepairs(taskId) {
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
        for (var i = 0; i < results.length; i++) {
            ids.push(results[i].id);
        }
        return ids;
    }

    function renderVrPdf(vrRec) {
        var renderer = render.create();

        renderer.setTemplateByScriptId({
            scriptId: TEMPLATE_ID
        });

        renderer.addRecord({
            templateName: 'record',
            record:       vrRec
        });

        return renderer.renderAsPdf();
    }

    function createMergedVrPdf(fileIds, taskId, folderId) {
        var xmlContent = '<?xml version="1.0"?>\n';
        xmlContent += '<!DOCTYPE pdf PUBLIC "-//big.faceless.org//report" "report-1.1.dtd">\n';
        xmlContent += '<pdfset>';

        for (var i = 0; i < fileIds.length; i++) {
            var loadedPdf = file.load({ id: fileIds[i] });
            var pdfUrl    = xml.escape({ xmlText: loadedPdf.url });
            xmlContent   += "<pdf src='" + pdfUrl + "'/>";
        }

        xmlContent += '</pdfset>';

        var mergedPdfObj = render.xmlToPdf({
            xmlString: xmlContent
        });

        var mergedPdfFile = file.create({
            name:     'VR_Merged_Task_' + taskId + '.pdf',
            fileType: file.Type.PDF,
            contents: mergedPdfObj.getContents(),
            folder:   folderId
        });

        mergedPdfFile.isOnline = true;

        var mergedFileId = mergedPdfFile.save();

        log.audit(
            'VR PDF',
            'Merged PDF created, fileId=' + mergedFileId
        );

        return mergedFileId;
    }

    function removeOldTaskAttachments(taskId) {
        try {
            var oldFileIds = [];

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
                    name: 'internalid',
                    join: 'file'
                });

                if (oldFileId) {
                    oldFileIds.push(oldFileId);
                }
            }

            for (var j = 0; j < oldFileIds.length; j++) {
                try {
                    record.detach({
                        record: { type: 'file', id: oldFileIds[j] },
                        from:   { type: 'task', id: taskId }
                    });

                    log.audit(
                        'VR PDF',
                        'Detached old file attachment: ' + oldFileIds[j] +
                        ' from Task ' + taskId
                    );
                } catch (detachErr) {
                    log.error(
                        'VR PDF Detach Error',
                        'File ' + oldFileIds[j] + ': ' + detachErr.message
                    );
                }
            }

        } catch (e) {
            log.error(
                'VR PDF',
                'Error removing old attachments from Task ' + taskId +
                ': ' + e.message
            );
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

        if (results.length) {
            return results[0].id;
        }

        var folderRec = record.create({
            type: record.Type.FOLDER
        });

        folderRec.setValue({
            fieldId: 'name',
            value:   folderName
        });

        if (parentId) {
            folderRec.setValue({
                fieldId: 'parent',
                value:   parentId
            });
        }

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

    return {
      //  beforeLoad:  beforeLoad,
        afterSubmit: afterSubmit
    };
});
