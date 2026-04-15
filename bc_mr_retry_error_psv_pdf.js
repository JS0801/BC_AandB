/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 * @NModuleScope SameAccount
 *
 * Re-processes Tasks that are COMPLETE but failed PSV PDF generation.
 * Mirrors the afterSubmit logic from the PSV UserEvent script.
 */
define([
  'N/record',
  'N/render',
  'N/search',
  'N/log'
], (record, render, search, log) => {

  /* ------------------------------------------------------------------ */
  /*  CONSTANTS – must match UserEvent script values                    */
  /* ------------------------------------------------------------------ */
  const PSV_RECORD_TYPE = 'customrecord_bc_psv';
  const TEMPLATE_ID     = 'CUSTTMPL_118_11915859_SB1_110';
  const ROOT_FOLDER_NAME = 'PSV Reports';

  /* ------------------------------------------------------------------ */
  /*  getInputData – run the saved search for failed tasks              */
  /* ------------------------------------------------------------------ */
  const getInputData = () => {
    return search.create({
      type: 'task',
      filters: [
        ['custevent_psv_error_log', 'isnotempty', ''],
        'AND',
        ['custevent_bc_psv_pdf_generated', 'is', 'F'],
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
    const result = JSON.parse(context.value);
    const taskId = result.id;
    const taskTitle = result.values.title || 'Untitled';

    log.audit('PSV MR Map', `Processing Task ${taskId}: ${taskTitle}`);

    try {
      // 1. Find linked PSV Test record
      const psvId = findPsvTestByTask(taskId);
      if (!psvId) {
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: `No PSV Test record linked to Task ${taskId}.`
          }
        });
        log.error('PSV MR Map', `No PSV Test record linked to Task ${taskId}. Skipping.`);
        return;
      }

      // 2. Load the PSV Test record
      const psvRec = record.load({ type: PSV_RECORD_TYPE, id: psvId });

      // 3. Render the Advanced PDF template
      const pdfFile = renderPsvPdf(psvRec);

      // 4. Build file name: PSV_Report_[WO#]_[MMDDYYYY].pdf
      let woNum = psvRec.getText({ fieldId: 'custrecord_bc_psv_work_order' }) || 'NOWO';
      if (woNum && woNum.indexOf('#') !== -1) {
        const parts = woNum.split('#');
        woNum = parts[1] ? parts[1].trim() : woNum;
      }
      const dateStr  = formatDateMMDDYYYY(new Date());
      const fileName = `PSV_Report_${sanitize(woNum)}_${dateStr}.pdf`;
      pdfFile.name = fileName;

      // 5. Create / find File Cabinet folder
      const rootFolderId = getOrCreateFolder(ROOT_FOLDER_NAME, null);
      const subFolderName = truncate(`Task-${taskId} – ${taskTitle}`, 100);
      const subFolderId = getOrCreateFolder(subFolderName, rootFolderId);
      pdfFile.folder = subFolderId;

      // 6. Save PDF to File Cabinet
      const fileId = pdfFile.save();
      log.audit('PSV MR Map', `PDF saved: fileId=${fileId}, name=${fileName}`);

      // 7. Write file ID back to PSV Test record and clear error
      record.submitFields({
        type: PSV_RECORD_TYPE,
        id: psvId,
        values: {
          custrecord_bc_psv_pdf_file_id: fileId,
          custrecord_bc_psv_pdf_error: ''
        }
      });

      // 8. Attach PDF file to the Task record
      record.attach({
        record: { type: 'file', id: fileId },
        to:     { type: 'task', id: taskId }
      });

      // 9. Flag Task as generated, store folder/file IDs, clear error log
      record.submitFields({
        type: record.Type.TASK,
        id: taskId,
        values: {
          custevent_bc_psv_pdf_generated: true,
          custevent_bc_psv_folder_id: subFolderId,
          custevent_bc_psv_pdf: fileId,
          custevent_psv_error_log: ''
        }
      });

      log.audit('PSV MR Map', `Successfully generated PDF for Task ${taskId}, PSV Test ${psvId}`);

      // Pass summary data to the summarize stage
      context.write({
        key: taskId,
        value: { psvId: psvId, fileId: fileId, status: 'success' }
      });

    } catch (e) {
      log.error('PSV MR Map Error', `Task ${taskId}: ${e.message}\n${e.stack}`);

      // Write error back to records
      try {
        const psvId = findPsvTestByTask(taskId);
        if (psvId) {
          record.submitFields({
            type: PSV_RECORD_TYPE,
            id: psvId,
            values: {
              custrecord_bc_psv_pdf_error: `${new Date().toISOString()} — MR Retry — ${e.message}`
            }
          });
        }
        record.submitFields({
          type: record.Type.TASK,
          id: taskId,
          values: {
            custevent_psv_error_log: `${new Date().toISOString()} — MR Retry — ${e.message}`
          }
        });
      } catch (inner) {
        log.error('PSV MR Map Error', `Could not log error to records: ${inner.message}`);
      }

      context.write({
        key: taskId,
        value: { status: 'error', message: e.message }
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
      } else {
        errorCount++;
        log.error('PSV MR Summary', `Task ${key} failed: ${data.message}`);
      }
      return true;
    });

    log.audit('PSV MR Summary', `Complete. Success: ${successCount}, Errors: ${errorCount}`);

    // Log any map-stage errors the framework caught
    summary.mapSummary.errors.iterator().each((key, error) => {
      log.error('PSV MR Framework Error', `Key: ${key}, Error: ${error}`);
      return true;
    });
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Find PSV Test record linked to a Task                     */
  /* ------------------------------------------------------------------ */
  const findPsvTestByTask = (taskId) => {
    const results = search.create({
      type: PSV_RECORD_TYPE,
      filters: [
        ['custrecord_bc_psv_task', 'anyof', taskId]
      ],
      columns: ['internalid']
    }).run().getRange({ start: 0, end: 1 });

    return results.length ? results[0].id : null;
  };

  /* ------------------------------------------------------------------ */
  /*  HELPER: Render Advanced PDF using N/render                        */
  /* ------------------------------------------------------------------ */
  const renderPsvPdf = (psvRec) => {
    const renderer = render.create();
    renderer.setTemplateByScriptId({ scriptId: TEMPLATE_ID });
    renderer.addRecord({
      templateName: 'record',
      record: psvRec
    });
    return renderer.renderAsPdf();
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

  /* ------------------------------------------------------------------ */
  /*  UTILITY HELPERS                                                   */
  /* ------------------------------------------------------------------ */
  const formatDateMMDDYYYY = (d) => {
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const dd   = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${mm}${dd}${yyyy}`;
  };

  const sanitize = (str) => String(str).replace(/[^a-zA-Z0-9_-]/g, '_');

  const truncate = (str, maxLen) => str.length > maxLen ? str.substring(0, maxLen) : str;

  return { getInputData, map, summarize };
});
