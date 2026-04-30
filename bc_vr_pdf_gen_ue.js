/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope SameAccount
 */
define([
    'N/record',
    'N/search',
    'N/render',
    'N/file',
    'N/runtime',
    'N/log',
    'N/format'
], function (record, search, render, file, runtime, log, format) {

        var CONFIG = {
          ROOT_FOLDER_ID: 3483,
          PDF_TEMPLATE_ID: 'CUSTTMPL_BC_VALVE_REPAIR_PDFHTML_TEMPLATE',
          CLOSED_STATUS: 'COMPLETE',
          VR_RECORD_TYPE: 'customrecord_bc_vr',
          VR_TASK_LINK_FIELD: 'custrecord_bc_vr_ab_control_num'
      };

    function afterSubmit(context) {


        try {
            // Skip delete events.
            if (context.type === context.UserEventType.DELETE) {
                return;
            }

            var newRec = context.newRecord;
            var taskId = newRec.id;


            var taskStatus = newRec.getValue({ fieldId: 'status' });

            log.debug({
                title: 'VR PDF UE - Trigger',
                details: 'Task ID: ' + taskId + ' | Status: ' + taskStatus
            });

            if (taskStatus !== CONFIG.CLOSED_STATUS) {
                return;
            }

            // -----------------------------------------------------------------
            // 1) Find all Valve Repair records linked to this Task.
            // -----------------------------------------------------------------
            var vrRecordIds = findLinkedValveRepairs(taskId);

            if (!vrRecordIds.length) {
                log.audit({
                    title: 'VR PDF UE - No Linked Valve Repairs',
                    details: 'Task ' + taskId + ' closed but has no linked ' +
                             'Valve Repair records. No PDFs will be generated.'
                });
                return;
            }

            // -----------------------------------------------------------------
            // 2) Ensure a sub-folder exists for this Task.
            // -----------------------------------------------------------------
            var folderId = ensureTaskFolder(taskId, newRec);

            // -----------------------------------------------------------------
            // 3) Loop each Valve Repair record and generate one PDF each.
            // -----------------------------------------------------------------
            var successCount = 0;
            var failureCount = 0;
            var errorEntries = []; // collected for Task-level rollup

            for (var i = 0; i < vrRecordIds.length; i++) {
                var vrId = vrRecordIds[i];
                try {
                    generateAndAttachPdf(vrId, taskId, folderId);
                    successCount++;
                } catch (perRecordErr) {
                    failureCount++;
                    var errMsg = logErrorOnVr(vrId, perRecordErr);
                    errorEntries.push('VR ' + vrId + ': ' + errMsg);
                }
            }

            // -----------------------------------------------------------------
            // 4) Post-loop: flag the Task only if every record succeeded.
            //    Always update the Task-level error log:
            //      - failures present  → write rollup of all messages
            //      - all succeeded     → clear the field
            // -----------------------------------------------------------------
            var allSucceeded = (failureCount === 0);
            var errorRollup = errorEntries.length
                ? errorEntries.join('\n\n').substring(0, 99999)
                : '';

            record.submitFields({
                type: record.Type.TASK,
                id: taskId,
                values: {
                    custbody_bc_vr_pdf_generated: allSucceeded,
                    custbody_bc_vr_folder_id: folderId,
                    custevent_bc_valve_error_log: errorRollup
                },
                options: { ignoreMandatoryFields: true }
            });

            log.audit({
                title: 'VR PDF UE - Completed',
                details: 'Task ' + taskId + ' | Success: ' + successCount +
                         ' | Failed: ' + failureCount + ' | Folder: ' + folderId
            });

        } catch (e) {
            // Top-level errors must never block Task save.
            log.error({
                title: 'VR PDF UE - Fatal',
                details: e.toString() + (e.stack ? '\n' + e.stack : '')
            });
        }
    }

    // ---------------------------------------------------------------------
    // SEARCH: linked Valve Repair records
    // ---------------------------------------------------------------------
    function findLinkedValveRepairs(taskId) {
        var ids = [];
        var s = search.create({
            type: CONFIG.VR_RECORD_TYPE,
            filters: [
                [CONFIG.VR_TASK_LINK_FIELD, 'anyof', taskId],
                'AND',
                ['isinactive', 'is', 'F']
            ],
            columns: ['internalid']
        });

        s.run().each(function (result) {
            ids.push(result.id);
            return true;
        });

        return ids;
    }

    // ---------------------------------------------------------------------
    // FOLDER: ensure a sub-folder exists for this Task
    // ---------------------------------------------------------------------
    function ensureTaskFolder(taskId, taskRec) {
        // If the Task already has a folder ID stored, reuse it.
        var existingFolderId = taskRec.getValue({
            fieldId: 'custbody_bc_vr_folder_id'
        });
        if (existingFolderId) {
            return existingFolderId;
        }

        var taskTitle = taskRec.getValue({ fieldId: 'title' }) || '';
        var folderName = ('Task-' + taskId + ' - ' + taskTitle)
            .replace(/[\\/:*?"<>|]/g, '-')   // strip illegal characters
            .substring(0, 100);              // hard cap per TDD

        // Try to find an existing folder with that name under root.
        var found = search.create({
            type: 'folder',
            filters: [
                ['name', 'is', folderName],
                'AND',
                ['parent', 'anyof', CONFIG.ROOT_FOLDER_ID]
            ],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });

        if (found && found.length) {
            return found[0].id;
        }

        // Create a new folder.
        var folderRec = record.create({ type: 'folder' });
        folderRec.setValue({ fieldId: 'name', value: folderName });
        folderRec.setValue({
            fieldId: 'parent',
            value: CONFIG.ROOT_FOLDER_ID
        });
        return folderRec.save();
    }

    // ---------------------------------------------------------------------
    // PDF: render, save, attach for ONE Valve Repair record
    // ---------------------------------------------------------------------
    function generateAndAttachPdf(vrId, taskId, folderId) {
        // 1) Render PDF using Advanced PDF template against the VR record.
        var renderer = render.create();
        renderer.setTemplateById({ id: CONFIG.PDF_TEMPLATE_ID });
        renderer.addRecord({
            templateName: 'record',
            record: record.load({
                type: CONFIG.VR_RECORD_TYPE,
                id: vrId
            })
        });

        var pdfFile = renderer.renderAsPdf();

        // 2) Build a deterministic filename:
        //    VR_Report_[WO#]_[AssetNum]_[MMDDYYYY].pdf
        var fileName = buildFileName(vrId, taskId);
        pdfFile.name = fileName;
        pdfFile.folder = folderId;

        // 3) Save and attach.
        var savedFileId = pdfFile.save();

        record.attach({
            record: { type: 'file', id: savedFileId },
            to:     { type: record.Type.TASK, id: taskId }
        });

        // 4) Write the file ID and clear any prior error on the VR record.
        record.submitFields({
            type: CONFIG.VR_RECORD_TYPE,
            id: vrId,
            values: {
                custrecord_bc_vr_pdf_file_id: savedFileId,
                custrecord_bc_vr_pdf_error: ''
            },
            options: { ignoreMandatoryFields: true }
        });
    }

    // ---------------------------------------------------------------------
    // FILENAME helper
    // ---------------------------------------------------------------------
    function buildFileName(vrId, taskId) {
        var lookup = search.lookupFields({
            type: CONFIG.VR_RECORD_TYPE,
            id: vrId,
            columns: [
                'custrecord_bc_vr_work_order',
                'custrecord_bc_vr_asset',
                'custrecord_bc_vr_pdf_file_id'
            ]
        });

        var woText = '';
        if (lookup.custrecord_bc_vr_work_order &&
            lookup.custrecord_bc_vr_work_order.length) {
            woText = lookup.custrecord_bc_vr_work_order[0].text || '';
        }

        var assetText = '';
        if (lookup.custrecord_bc_vr_asset &&
            lookup.custrecord_bc_vr_asset.length) {
            assetText = lookup.custrecord_bc_vr_asset[0].text || '';
        }

        var d = new Date();
        var mm = pad(d.getMonth() + 1);
        var dd = pad(d.getDate());
        var yyyy = d.getFullYear();
        var datePart = '' + mm + dd + yyyy;

        var safeWo = sanitize(woText) || 'WO';
        var safeAsset = sanitize(assetText) || ('VR' + vrId);

        // If a PDF already exists for this record, append a timestamp so the
        // re-close lifecycle (UC-003) preserves the original.
        var versionSuffix = '';
        if (lookup.custrecord_bc_vr_pdf_file_id) {
            versionSuffix = '_v' + d.getTime();
        }

        return 'VR_Report_' + safeWo + '_' + safeAsset + '_' +
               datePart + versionSuffix + '.pdf';
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    function sanitize(s) {
        return String(s || '')
            .replace(/[^A-Za-z0-9_-]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    // ---------------------------------------------------------------------
    // ERROR: write to VR record's error field, return message for rollup
    // ---------------------------------------------------------------------
    function logErrorOnVr(vrId, err) {
        var msg = (err && err.toString) ? err.toString() : String(err);
        if (err && err.stack) { msg += '\n' + err.stack; }

        log.error({
            title: 'VR PDF UE - Per-record failure',
            details: 'VR ' + vrId + ': ' + msg
        });

        try {
            record.submitFields({
                type: CONFIG.VR_RECORD_TYPE,
                id: vrId,
                values: {
                    custrecord_bc_vr_pdf_error: msg.substring(0, 3999)
                },
                options: { ignoreMandatoryFields: true }
            });
        } catch (writeErr) {
            log.error({
                title: 'VR PDF UE - Could not log error to VR record',
                details: 'VR ' + vrId + ': ' + writeErr
            });
        }

        return msg;
    }

    return { afterSubmit: afterSubmit };
});
