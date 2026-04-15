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
  'N/url'
], (record, render, search, file, log, url) => {

  const PSV_RECORD_TYPE  = 'customrecord_bc_psv';
  const TEMPLATE_ID      = 'CUSTTMPL_118_11915859_SB1_110';
  const ROOT_FOLDER_NAME = 'PSV Reports';
  const SUITELET_SCRIPT  = 'customscript_bc_sl_psv_pdf_helper';
  const SUITELET_DEPLOY  = 'customdeploy_bc_sl_psv_pdf_helper';

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
    const status = taskRec.getValue({ fieldId: 'status' });
  //  if (status !== 'COMPLETE') return;

    const taskId = taskRec.id;
    const taskTitle = taskRec.getValue({ fieldId: 'title' }) || 'Untitled';

    try {
      const psvIds = findPsvTestsByTask(taskId);

      if (!psvIds.length) {
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: 'No PSV records linked to Task ' + taskId
          }
        });
        return;
      }

      // 1. Clear current merged file field
      record.submitFields({
        type: record.Type.TASK,
        id: taskId,
        values: {
          custevent_bc_psv_pdf: '',
          custevent_psv_error_log: ''
        }
      });

      // 2. Remove old attached PDF files
      removeOldAttachedPdfFiles(taskId);

      // 3. Render each PSV as XML
      var xmlParts = [];
      var fileNameSeed = 'NOWO';

      for (var i = 0; i < psvIds.length; i++) {
        var psvRec = record.load({
          type: PSV_RECORD_TYPE,
          id: psvIds[i]
        });

        if (i === 0) {
          fileNameSeed = psvRec.getText({ fieldId: 'custrecord_bc_psv_work_order' }) || 'NOWO';
          if (fileNameSeed.indexOf('#') !== -1) {
            var parts = fileNameSeed.split('#');
            fileNameSeed = parts[1] ? parts[1].trim() : fileNameSeed;
          }
        }

        var xmlString = renderSinglePsvXml(psvRec);
        xmlParts.push(stripOuterPdfTags(xmlString));
      }

      // 4. Merge XML using pdfset
      var mergedXml = buildPdfSetXml(xmlParts);

      // 5. Convert merged XML to final PDF
      var mergedPdf = render.xmlToPdf({
        xmlString: mergedXml
      });

      var rootFolderId = getOrCreateFolder(ROOT_FOLDER_NAME, null);
      var subFolderName = truncate('Task-' + taskId + ' - ' + taskTitle, 100);
      var subFolderId = getOrCreateFolder(subFolderName, rootFolderId);

      mergedPdf.name = 'PSV_Report_' + sanitize(fileNameSeed) + '_' + formatDateMMDDYYYY(new Date()) + '.pdf';
      mergedPdf.folder = subFolderId;

      var mergedFileId = mergedPdf.save();

      // 6. Update PSV records with merged file
      for (var j = 0; j < psvIds.length; j++) {
        record.submitFields({
          type: PSV_RECORD_TYPE,
          id: psvIds[j],
          values: {
            custrecord_bc_psv_pdf_file_id: mergedFileId,
            custrecord_bc_psv_pdf_error: ''
          }
        });
      }

      // 7. Attach only merged file
      record.attach({
        record: { type: 'file', id: mergedFileId },
        to: { type: 'task', id: taskId }
      });

      // 8. Store merged file in task field
      record.submitFields({
        type: record.Type.TASK,
        id: taskId,
        values: {
          custevent_bc_psv_pdf_generated: true,
          custevent_bc_psv_folder_id: subFolderId,
          custevent_bc_psv_pdf: mergedFileId,
          custevent_psv_error_log: ''
        }
      });

      log.audit('PSV PDF', 'Merged PDF created. fileId=' + mergedFileId);

    } catch (e) {
      log.error('PSV PDF Error', 'Task ' + taskId + ': ' + e.message);

      try {
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: new Date().toISOString() + ' - ' + e.message
          }
        });
      } catch (inner) {
        log.error('PSV PDF Error', 'Could not log error: ' + inner.message);
      }
    }
  };

  const findPsvTestsByTask = (taskId) => {
    var results = search.create({
      type: 'customrecord_bc_psv',
      filters: [
        ['custrecord_bc_psv_task', 'anyof', taskId]
      ],
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1000 });

    var ids = [];
    for (var i = 0; i < results.length; i++) {
      ids.push(results[i].id);
    }
    return ids;
  };

  const renderSinglePsvXml = (psvRec) => {
    var renderer = render.create();
    renderer.setTemplateByScriptId({
      scriptId: TEMPLATE_ID
    });
    renderer.addRecord({
      templateName: 'record',
      record: psvRec
    });
    return renderer.renderAsString();
  };

  const stripOuterPdfTags = (xmlString) => {
    return xmlString
      .replace(/<\\?xml[^>]*>/i, '')
      .replace(/<!DOCTYPE[^>]*>/i, '')
      .replace(/<pdf[^>]*>/i, '')
      .replace(/<\/pdf>/i, '')
      .trim();
  };

  const buildPdfSetXml = (xmlParts) => {
    var xml = '<?xml version="1.0"?>';
    xml += '<pdfset>';

    for (var i = 0; i < xmlParts.length; i++) {
      xml += '<pdf>';
      xml += xmlParts[i];
      xml += '</pdf>';
    }

    xml += '</pdfset>';
    return xml;
  };

  const removeOldAttachedPdfFiles = (taskId) => {
    try {
      var oldFieldFileId = getTaskPdfFieldValue(taskId);
      var attachedFileIds = getAttachedPdfFileIds(taskId);

      for (var i = 0; i < attachedFileIds.length; i++) {
        try {
          record.detach({
            record: { type: 'file', id: attachedFileIds[i] },
            from: { type: 'task', id: taskId }
          });
        } catch (e1) {
          log.error('DETACH ERROR', attachedFileIds[i] + ': ' + e1.message);
        }
      }

      if (oldFieldFileId) {
        try {
          file.delete({ id: oldFieldFileId });
        } catch (e2) {
          log.error('DELETE FIELD FILE ERROR', oldFieldFileId + ': ' + e2.message);
        }
      }

      for (var j = 0; j < attachedFileIds.length; j++) {
        if (String(attachedFileIds[j]) !== String(oldFieldFileId)) {
          try {
            file.delete({ id: attachedFileIds[j] });
          } catch (e3) {
            log.error('DELETE ATTACHED FILE ERROR', attachedFileIds[j] + ': ' + e3.message);
          }
        }
      }
    } catch (e) {
      log.error('REMOVE OLD FILES ERROR', e.message);
    }
  };

  const getTaskPdfFieldValue = (taskId) => {
    var data = search.lookupFields({
      type: record.Type.TASK,
      id: taskId,
      columns: ['custevent_bc_psv_pdf']
    });

    if (data.custevent_bc_psv_pdf && data.custevent_bc_psv_pdf.length) {
      return data.custevent_bc_psv_pdf[0].value;
    }
    return '';
  };

  const getAttachedPdfFileIds = (taskId) => {
    var ids = [];

    var results = search.create({
      type: search.Type.FILE,
      filters: [
        ['attachedto', 'anyof', taskId],
        'AND',
        ['filetype', 'anyof', 'PDF']
      ],
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1000 });

    for (var i = 0; i < results.length; i++) {
      ids.push(results[i].getValue({ name: 'internalid' }));
    }

    return ids;
  };

  const getOrCreateFolder = (folderName, parentId) => {
    var filters = [['name', 'is', folderName]];

    if (parentId) {
      filters.push('AND', ['parent', 'anyof', parentId]);
    } else {
      filters.push('AND', ['parent', 'anyof', '@NONE@']);
    }

    var results = search.create({
      type: search.Type.FOLDER,
      filters: filters,
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1 });

    if (results.length) return results[0].id;

    var folderRec = record.create({ type: record.Type.FOLDER });
    folderRec.setValue({ fieldId: 'name', value: folderName });
    if (parentId) {
      folderRec.setValue({ fieldId: 'parent', value: parentId });
    }
    return folderRec.save();
  };

  const formatDateMMDDYYYY = (d) => {
    var mm = String(d.getMonth() + 1).padStart(2, '0');
    var dd = String(d.getDate()).padStart(2, '0');
    var yyyy = d.getFullYear();
    return mm + dd + yyyy;
  };

  const sanitize = (str) => String(str).replace(/[^a-zA-Z0-9_-]/g, '_');

  const truncate = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

  return { beforeLoad, afterSubmit };
});