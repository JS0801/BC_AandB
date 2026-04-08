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
    'N/log'
], (record, render, search, file, log) => {

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
            log.error('PSV Suitelet', 'Task ' + taskId + ': ' + e.message);
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

    /* ---- REGENERATE (same logic as UE afterSubmit) ---- */
    const handleRegenerate = (context, taskId) => {
        const taskRec   = record.load({ type: record.Type.TASK, id: taskId });
        const taskTitle = taskRec.getValue({ fieldId: 'title' }) || 'Untitled';

        // Find linked PSV Test
        const psvId = findPsvTestByTask(taskId);
        if (!psvId) {
            sendJson(context, false, 'No PSV Test record linked to this Task.');
            return;
        }

        const psvRec = record.load({ type: PSV_RECORD_TYPE, id: psvId });

        // Render PDF
        const renderer = render.create();
        renderer.setTemplateByScriptId({ scriptId: TEMPLATE_ID });
        renderer.addRecord({ templateName: 'record', record: psvRec });
        const pdfFile = renderer.renderAsPdf();

        // File name – same WO# parsing logic as UE
        var woNum = psvRec.getText({ fieldId: 'custrecord_bc_psv_work_order' }) || 'NOWO';
        if (woNum && woNum.indexOf('#') !== -1) {
            var parts = woNum.split('#');
            woNum = parts[1] ? parts[1].trim() : woNum;
        }
        const now     = new Date();
        const dateStr = formatDateMMDDYYYY(now);
        const timeStr = String(now.getHours()).padStart(2, '0') +
                        String(now.getMinutes()).padStart(2, '0') +
                        String(now.getSeconds()).padStart(2, '0');
        pdfFile.name = 'PSV_Report_' + sanitize(woNum) + '_' + dateStr + '_' + timeStr + '.pdf';

        // Folder
        const rootFolderId  = getOrCreateFolder(ROOT_FOLDER_NAME, null);
        const subFolderName = truncate('Task-' + taskId + ' – ' + taskTitle, 100);
        const subFolderId   = getOrCreateFolder(subFolderName, rootFolderId);
        pdfFile.folder      = subFolderId;

        const fileId = pdfFile.save();
        log.audit('PSV Regen', 'Regenerated PDF fileId=' + fileId + ' for Task ' + taskId);

        // Update PSV Test
        record.submitFields({
            type: PSV_RECORD_TYPE,
            id: psvId,
            values: { custrecord_bc_psv_pdf_file_id: fileId, custrecord_bc_psv_pdf_error: '' }
        });

        // Attach to Task
        record.attach({
            record: { type: 'file', id: fileId },
            to:     { type: 'task', id: taskId }
        });

        // Flag Task
        record.submitFields({
            type: record.Type.TASK,
            id: taskId,
            values: {
                custevent_bc_psv_pdf_generated: true,
                custevent_bc_psv_folder_id: subFolderId
            }
        });

        sendJson(context, true, 'PDF regenerated successfully.', fileId);
    };

    /* ---- HELPERS ---- */
    const sendJson = (context, success, message, fileId) => {
        const payload = { success: success, message: message };
        if (fileId) payload.fileId = fileId;
        context.response.setHeader({ name: 'Content-Type', value: 'application/json' });
        context.response.write(JSON.stringify(payload));
    };

    const findPsvTestByTask = (taskId) => {
        const results = search.create({
            type: PSV_RECORD_TYPE,
            filters: [['custrecord_bc_psv_task', 'anyof', taskId]],
            columns: ['internalid']
        }).run().getRange({ start: 0, end: 1 });
        return results.length ? results[0].id : null;
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
    const truncate = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

    return { onRequest };
});
