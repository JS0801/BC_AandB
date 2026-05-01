/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Re-processes Tasks that are COMPLETE but failed Valve Repair PDF generation.
 * Mirrors the afterSubmit logic from the VR User Event script.
 *
 * Script ID: customscript_bc_mr_retry_error_vr_pdf
 */
define([
  'N/record',
  'N/render',
  'N/search',
  'N/file',
  'N/log',
  'N/url'
], (record, render, search, file, log, url) => {

  /* ------------------------------------------------------------------ */
  /*  CONSTANTS – must match UserEvent script values                    */
  /* ------------------------------------------------------------------ */
  const VR_RECORD_TYPE     = 'customrecord_bc_vr';
  const TEMPLATE_ID        = 'CUSTTMPL_BC_VALVE_REPAIR_PDFHTML_TEMPLATE';
  const ROOT_FOLDER_ID     = 3483;            // "VR Reports" root folder
  const VR_TASK_LINK_FIELD = 'custrecord_bc_vr_ab_control_num';

  /* ------------------------------------------------------------------ */
  /*  getInputData – Tasks that closed with errors and have no merged   */
  /*                 PDF on file                                        */
  /* ------------------------------------------------------------------ */
  const getInputData = () => {
    return search.create({
      type: 'task',
      filters: [
        ['custevent_bc_valve_error_log', 'isnotempty', ''],
        'AND',
        ['custevent_bc_vr_pdf_generated', 'isempty', ''],
        'AND',
        ['status', 'anyof', 'COMPLETE']
      ],
      columns: [
        search.createColumn({ name: 'internalid' }),
        search.createColumn({ name: 'title' })
      ]
    });
  };

  /* ------------------------------------------------------------------ */
  /*  map – re-run full PDF generation for each task                    */
  /* ------------------------------------------------------------------ */
  const map = (context) => {
    const result    = JSON.parse(context.value);
    const taskId    = result.id;
    const taskTitle = result.values.title || 'Untitled';

    log.audit('VR MR Map', 'Processing Task ' + taskId + ': ' + taskTitle);

    try {
      // 1. Find ALL linked Valve Repair records
      const vrIds = findValveRepairsByTask(taskId);
      if (!vrIds || !vrIds.length) {
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_bc_valve_error_log:
              'No Valve Repair records linked to Task ' + taskId + '.'
          }
        });
        log.error('VR MR Map',
          'No Valve Repair records linked to Task ' + taskId + '. Skipping.');
        context.write({
          key: taskId,
          value: JSON.stringify({
            status: 'error',
            message: 'No Valve Repair records linked.'
          })
        });
        return;
      }

      // 2. Resolve / create Task sub-folder under VR Reports root
      const subFolderName = truncate('Task-' + taskId + ' - ' + taskTitle, 100);
      const subFolderId   = getOrCreateFolder(subFolderName, ROOT_FOLDER_ID);

      // 3. Detach old file attachments before regenerating
      removeOldTaskAttachments(taskId);

      var createdIndividualFileIds = [];
      var errorMessages = [];
      var successCount  = 0;

      // 4. Loop each VR record - render, save, attach
      for (var i = 0; i < vrIds.length; i++) {
        var vrId = vrIds[i];

        try {
          var vrRec = record.load({ type: VR_RECORD_TYPE, id: vrId });

          var pdfFile = renderVrPdf(vrRec);

          // Filename: VR_Report_[WO#]_[AssetNum]_[MMDDYYYY].pdf
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

          // Update VR record - clear any previous error
          record.submitFields({
            type: VR_RECORD_TYPE,
            id: vrId,
            values: {
              custrecord_bc_vr_pdf_file_id: fileId,
              custrecord_bc_vr_pdf_error: ''
            }
          });

          // Attach individual PDF to Task
          record.attach({
            record: { type: 'file', id: fileId },
            to:     { type: 'task', id: taskId }
          });

          log.audit('VR MR Map',
            'Generated PDF for VR ' + vrId + ', fileId=' + fileId);

        } catch (vrErr) {
          var msg = vrErr && vrErr.message ? vrErr.message : String(vrErr);
          errorMessages.push('VR ' + vrId + ': ' + msg);
          log.error('VR MR Map Error', 'VR ' + vrId + ': ' + msg);

          try {
            record.submitFields({
              type: VR_RECORD_TYPE,
              id: vrId,
              values: {
                custrecord_bc_vr_pdf_error:
                  new Date().toISOString() + ' - MR Retry - ' + msg
              }
            });
          } catch (innerErr) {
            log.error('VR MR Map Error',
              'Could not update VR error for ' + vrId + ': ' + innerErr.message);
          }
        }
      }

      // 5. Merge all individual PDFs into one combined file
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

      // 6. Update Task record - folder ID, merged file ID, error log rollup
      record.submitFields({
        type: record.Type.TASK,
        id: taskId,
        values: {
          custevent_bc_vr_folder_id:     subFolderId,
          custevent_bc_vr_pdf_generated: mergedFileId || '',
          custevent_bc_valve_error_log:  errorMessages.join('\n')
        }
      });

      log.audit('VR MR Map',
        'Task ' + taskId + ': ' + successCount +
        ' PDF(s) generated. Merged fileId=' + mergedFileId);

      context.write({
        key: taskId,
        value: JSON.stringify({
          status: 'success',
          successCount: successCount,
          mergedFileId: mergedFileId,
          errors: errorMessages
        })
      });

    } catch (e) {
      log.error('VR MR Map Error',
        'Task ' + taskId + ': ' + e.message + '\n' + e.stack);

      try {
        const vrIds = findValveRepairsByTask(taskId);
        for (var j = 0; j < vrIds.length; j++) {
          try {
            record.submitFields({
              type: VR_RECORD_TYPE,
              id: vrIds[j],
              values: {
                custrecord_bc_vr_pdf_error:
                  new Date().toISOString() + ' — MR Retry — ' + e.message
              }
            });
          } catch (innerErr) {
            log.error('VR MR Map Error',
              'Could not update VR error for ' + vrIds[j] +
              ': ' + innerErr.message);
          }
        }
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_bc_valve_error_log:
              new Date().toISOString() + ' — MR Retry — ' + e.message
          }
        });
      } catch (inner) {
        log.error('VR MR Map Error',
          'Could not log error to records: ' + inner.message);
      }

      context.write({
        key: taskId,
        value: JSON.stringify({ status: 'error', message: e.message })
      });
    }
  };

  /* ------------------------------------------------------------------ */
  /*  summarize – log totals                                            */
  /* ------------------------------------------------------------------ */
  const summarize = (summary) => {
    let successCount = 0;
    let errorCount   = 0;

    summary.output.iterator().each((key, value) => {
      const data = JSON.parse(value);
      if (data.status === 'success') {
        successCount++;
        if (data.errors && data.errors.length) {
          log.error('VR MR Summary',
            'Task ' + key + ' succeeded overall but had VR-level errors: ' +
            data.errors.join(' | '));
        }
      } else {
        errorCount++;
        log.error('VR MR Summary',
          'Task ' + key + ' failed: ' + data.message);
      }
      return true;
    });

    log.audit('VR MR Summary',
      'Complete. Success: ' + successCount + ', Errors: ' + errorCount);

    summary.mapSummary.errors.iterator().each((key, error) => {
      log.error('VR MR Framework Error',
        'Key: ' + key + ', Error: ' + error);
      return true;
    });
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Find ALL Valve Repair records linked to a Task            */
  /* ------------------------------------------------------------------ */
  const findValveRepairsByTask = (taskId) => {
    const results = search.create({
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
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Render individual Advanced PDF                            */
  /* ------------------------------------------------------------------ */
  const renderVrPdf = (vrRec) => {
    const renderer = render.create();
    renderer.setTemplateByScriptId({ scriptId: TEMPLATE_ID });
    renderer.addRecord({ templateName: 'record', record: vrRec });
    return renderer.renderAsPdf();
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Merge individual PDFs into one via BFO pdfset             */
  /* ------------------------------------------------------------------ */
  const createMergedVrPdf = (fileIds, taskId, folderId) => {
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
      // Escape & to &amp; so the BFO XML parser doesn't choke on query string params
      var escapedUrl = rawUrl.replace(/&/g, '&amp;');
      xmlContent += '<pdf src="' + escapedUrl + '"/>';
    }

    xmlContent += '</pdfset>';

    log.debug('VR MR Merged XML', xmlContent);

    var mergedPdfObj      = render.xmlToPdf({ xmlString: xmlContent });
    mergedPdfObj.name     = 'VR_Merged_Task_' + taskId + '.pdf';
    mergedPdfObj.folder   = folderId;
    mergedPdfObj.isOnline = true;

    var mergedFileId = mergedPdfObj.save();
    log.audit('VR MR Map', 'Merged PDF created, fileId=' + mergedFileId);
    return mergedFileId;
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Detach old file attachments from Task                     */
  /* ------------------------------------------------------------------ */
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
        var oldFileId = taskFileSearch[i].getValue({
          name: 'internalid', join: 'file'
        });
        if (oldFileId) oldFileIds.push(oldFileId);
      }

      for (var j = 0; j < oldFileIds.length; j++) {
        try {
          record.detach({
            record: { type: 'file', id: oldFileIds[j] },
            from:   { type: 'task', id: taskId }
          });
          log.audit('VR MR Map',
            'Detached old file ' + oldFileIds[j] + ' from Task ' + taskId);
        } catch (detachErr) {
          log.error('VR MR Detach Error',
            'File ' + oldFileIds[j] + ': ' + detachErr.message);
        }
      }
    } catch (e) {
      log.error('VR MR Map',
        'Error removing old attachments from Task ' + taskId + ': ' + e.message);
    }
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Get or create a File Cabinet folder                       */
  /* ------------------------------------------------------------------ */
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

    if (results.length) return results[0].id;

    const folderRec = record.create({ type: record.Type.FOLDER });
    folderRec.setValue({ fieldId: 'name', value: folderName });
    if (parentId) folderRec.setValue({ fieldId: 'parent', value: parentId });
    return folderRec.save();
  };

  /* ------------------------------------------------------------------ */
  /*  UTILITY HELPERS                                                   */
  /* ------------------------------------------------------------------ */
  const formatDateMMDDYYYY = (d) => {
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return mm + dd + yyyy;
  };

  const sanitize = (str) => String(str || '').replace(/[^a-zA-Z0-9_-]/g, '_');
  const truncate = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

  return { getInputData, map, summarize };
});
