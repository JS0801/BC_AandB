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
  'N/url'
], (record, render, search, file, log, format, url) => {

  const PSV_RECORD_TYPE    = 'customrecord_bc_psv';
  const TEMPLATE_ID        = 'CUSTTMPL_118_11915859_SB1_110';
  const ROOT_FOLDER_NAME   = 'PSV Reports';
  const TASK_STATUS_CLOSED = 'COMPLETE';
  const SUITELET_SCRIPT    = 'customscript_bc_sl_psv_pdf_helper';
  const SUITELET_DEPLOY    = 'customdeploy_bc_sl_psv_pdf_helper';

  const beforeLoad = (context) => {
    if (context.type !== context.UserEventType.VIEW) return;

    const taskRec = context.newRecord;
    const taskId  = taskRec.id;
    const fileId  = taskRec.getValue({ fieldId: 'custevent_bc_psv_pdf' });

    const suiteletUrl = url.resolveScript({
      scriptId: SUITELET_SCRIPT,
      deploymentId: SUITELET_DEPLOY,
      params: { taskId: taskId }
    });

    if (fileId) {
      const previewUrl = suiteletUrl + '&action=preview';
      context.form.addButton({
        id: 'custpage_btn_preview_pdf',
        label: 'Preview PSV PDF',
        functionName: "bcPsvPreview('" + previewUrl + "')"
      });
    }

    const regenUrl = suiteletUrl + '&action=regenerate';
    context.form.addButton({
      id: 'custpage_btn_regen_pdf',
      label: 'Regenerate PSV PDF',
      functionName: "bcPsvRegenerate('" + regenUrl + "')"
    });

    context.form.clientScriptModulePath = './bc_psv_pdf_cs.js';
  };

  const afterSubmit = (context) => {
    if (
      context.type !== context.UserEventType.CREATE &&
      context.type !== context.UserEventType.EDIT
    ) {
      return;
    }

    const taskRec = context.newRecord;
    const newStatus = taskRec.getValue({ fieldId: 'status' });

   // if (newStatus !== 'COMPLETE') return;

    const taskId    = taskRec.id;
    const taskTitle = taskRec.getValue({ fieldId: 'title' }) || 'Untitled';

    try {
      const psvIds = findPsvTestsByTask(taskId);

      if (!psvIds || !psvIds.length) {
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: 'No PSV Test records linked to Task ' + taskId + '.'
          }
        });

        log.error('PSV PDF', 'No PSV Test records linked to Task ' + taskId);
        return;
      }

      const rootFolderId = getOrCreateFolder(ROOT_FOLDER_NAME, null);
      const subFolderName = truncate('Task-' + taskId + ' - ' + taskTitle, 100);
      const subFolderId = getOrCreateFolder(subFolderName, rootFolderId);

      let firstFileId = '';
      let successCount = 0;
      let errorMessages = [];

      for (let i = 0; i < psvIds.length; i++) {
        const psvId = psvIds[i];

        try {
          const psvRec = record.load({
            type: PSV_RECORD_TYPE,
            id: psvId
          });

          const pdfFile = renderPsvPdf(psvRec);

          var woNum = psvRec.getText({ fieldId: 'custrecord_bc_psv_work_order' }) || 'NOWO';

          if (woNum && woNum.indexOf('#') !== -1) {
            var parts = woNum.split('#');
            woNum = parts[1] ? parts[1].trim() : woNum;
          }

          const dateStr = formatDateMMDDYYYY(new Date());
          const fileName = 'PSV_Report_' + sanitize(woNum) + '_' + psvId + '_' + dateStr + '.pdf';

          pdfFile.name = fileName;
          pdfFile.folder = subFolderId;

          const fileId = pdfFile.save();

          if (!firstFileId) {
            firstFileId = fileId;
          }

          record.submitFields({
            type: PSV_RECORD_TYPE,
            id: psvId,
            values: {
              custrecord_bc_psv_pdf_file_id: fileId,
              custrecord_bc_psv_pdf_error: ''
            }
          });

          record.attach({
            record: { type: 'file', id: fileId },
            to: { type: 'task', id: taskId }
          });

          successCount++;

          log.audit('PSV PDF', 'Generated PDF for PSV ' + psvId + ', fileId=' + fileId);

        } catch (psvErr) {
          errorMessages.push('PSV ' + psvId + ': ' + psvErr.message);

          try {
            record.submitFields({
              type: PSV_RECORD_TYPE,
              id: psvId,
              values: {
                custrecord_bc_psv_pdf_error: new Date().toISOString() + ' - ' + psvErr.message
              }
            });
          } catch (innerErr) {
            log.error('PSV PDF Error', 'Could not update PSV error for ' + psvId + ': ' + innerErr.message);
          }

          log.error('PSV PDF Error', 'PSV ' + psvId + ': ' + psvErr.message);
        }
      }

      record.submitFields({
        type: record.Type.TASK,
        id: taskId,
        values: {
          custevent_bc_psv_pdf_generated: successCount > 0,
          custevent_bc_psv_folder_id: subFolderId,
          custevent_bc_psv_pdf: firstFileId || '',
          custevent_psv_error_log: errorMessages.join('\n')
        }
      });

      log.audit(
        'PSV PDF',
        'Task ' + taskId + ': ' + successCount + ' PDF(s) generated out of ' + psvIds.length
      );

    } catch (e) {
      log.error('PSV PDF Error', 'Task ' + taskId + ': ' + e.message + '\n' + e.stack);

      try {
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: new Date().toISOString() + ' - ' + e.message
          }
        });
      } catch (inner) {
        log.error('PSV PDF Error', 'Could not log task error: ' + inner.message);
      }
    }
  };

  const findPsvTestsByTask = (taskId) => {
    const results = search.create({
      type: PSV_RECORD_TYPE,
      filters: [
        ['custrecord_bc_psv_task', 'anyof', taskId]
      ],
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1000 });

    const ids = [];

    for (let i = 0; i < results.length; i++) {
      ids.push(results[i].id);
    }

    return ids;
  };

  const renderPsvPdf = (psvRec) => {
    const renderer = render.create();

    renderer.setTemplateByScriptId({
      scriptId: TEMPLATE_ID
    });

    renderer.addRecord({
      templateName: 'record',
      record: psvRec
    });

    return renderer.renderAsPdf();
  };

  const getOrCreateFolder = (folderName, parentId) => {
    const filters = [['name', 'is', folderName]];

    if (parentId) {
      filters.push('AND', ['parent', 'anyof', parentId]);
    } else {
      filters.push('AND', ['parent', 'anyof', '@NONE@']);
    }

    const results = search.create({
      type: search.Type.FOLDER,
      filters: filters,
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1 });

    if (results.length) {
      return results[0].id;
    }

    const folderRec = record.create({ type: record.Type.FOLDER });
    folderRec.setValue({ fieldId: 'name', value: folderName });

    if (parentId) {
      folderRec.setValue({ fieldId: 'parent', value: parentId });
    }

    return folderRec.save();
  };

  const formatDateMMDDYYYY = (d) => {
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return mm + dd + yyyy;
  };

  const sanitize = (str) => String(str).replace(/[^a-zA-Z0-9_-]/g, '_');

  const truncate = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

  return { beforeLoad, afterSubmit };
});