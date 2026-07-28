/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/record', 'N/log', 'N/search'], function (record, log, search) {
    const FIELD = {
      EMPLOYEE: 'employee',
      TRANDATE: 'trandate',
      CUSTOMER: 'customer',
      TASK: 'casetaskevent',
      HOURS: 'hours',
      ITEM: 'item',
      IS_BILLABLE: 'isbillable',
      DEPARTMENT: 'department',
      LOCATION: 'location',
      TIME_START: 'custcol_nx_time_start',
      TIME_END: 'custcol_nx_time_end',
      PROCESSED: 'custcol_bc_split_processed',
      MANLIFT: 'custcol_bc_manlift',
      GREASE_GUN: 'custcol_bc_grease_gun',
      VR_TRAILER: 'custcol_bc_vr_trailer',
      RELATED_TIME_ENTRIES: 'custcol_bc_related_time_entries',
      NX_ASSET: 'custcol_nx_asset',
      NX_CASE: 'custcol_nx_case',
      NX_TASK: 'custcol_nx_task',
      NX_PROJECT_TASK: 'custcol_nx_projecttask',
      NX_IDEMPOTENCY_KEY: 'custcol_nx_idempotency_key',
      ITEM_ROLE: 'custitem_bc_fsm_item_role',
      ITEM_OT: 'custitem_bc_fsm_ot_item',
  
      TASK_LEAD: 'assigned',
      TASK_TEAM: 'custevent_nx_task_team',
      TASK_TYPE: 'custevent_nx_task_type',
      TASK_CUSTOMER: 'custevent_nx_customer',
      TASK_CASE: 'supportcase',
      TASK_ASSET: 'custevent_nx_task_asset',
      TASK_JOB: 'company',
  
      CASE_SO: 'custevent_nx_case_transaction',
      CASE_SUBSIDIARY: 'subsidiary',
  
      SO_ASSET: 'custbody_nx_asset',
      SO_CASE: 'custbody_nx_case',
  
      ASSET_DISTANCE: 'custrecord_bc_fsm_asset_dist_yard'
    };
  
    const OXY_CUSTOMER_ID = '1480';
    const FALLBACK_TEST_RATE = 100;
    const SHOP_DELIVERY_TASK_TYPES = ['15', '16', '17', '18'];
    const ASSET_RECORD_TYPE = 'customrecord_nx_asset';
    const TIMEBILL_RECORD_TYPE = 'timebill';
    const TIMEBILL_SNAPSHOT_FIELDS = [
      FIELD.TRANDATE,
      FIELD.EMPLOYEE,
      FIELD.CUSTOMER,
      FIELD.TASK,
      FIELD.ITEM,
      FIELD.IS_BILLABLE,
      FIELD.DEPARTMENT,
      FIELD.LOCATION,
      FIELD.TIME_START,
      FIELD.TIME_END,
      FIELD.HOURS,
      FIELD.NX_ASSET,
      FIELD.NX_CASE,
      FIELD.NX_TASK,
      FIELD.NX_PROJECT_TASK,
      FIELD.MANLIFT,
      FIELD.GREASE_GUN,
      FIELD.VR_TRAILER
    ];
    const ITEM_ROLE = {
      TRUCK_TOOLS: '1',
      SAFETY_FEE: '2',
      MILEAGE: '3',
      MANLIFT: '4',
      GREASE_GUN: '5',
      VR_TRAILER: '6',
      OXY_TOOLS_RT: '7',
      OXY_TOOLS_OT: '8',
      OXY_TRAILER_RT: '9',
      OXY_TRAILER_OT: '10',
      RT_SERVICE_ITEM: '11',
      OT_SERVICE_ITEM: '12'
    };
    const BILLING_ITEM_ROLES = [
      ITEM_ROLE.TRUCK_TOOLS,
      ITEM_ROLE.SAFETY_FEE,
      ITEM_ROLE.MILEAGE,
      ITEM_ROLE.MANLIFT,
      ITEM_ROLE.GREASE_GUN,
      ITEM_ROLE.VR_TRAILER,
      ITEM_ROLE.OXY_TOOLS_RT,
      ITEM_ROLE.OXY_TOOLS_OT,
      ITEM_ROLE.OXY_TRAILER_RT,
      ITEM_ROLE.OXY_TRAILER_OT
    ];
  
    function afterSubmit(context) {
      if (context.type !== context.UserEventType.CREATE && context.type !== context.UserEventType.EDIT) {
        return;
      }
  
      const timebillId = context.newRecord.id;
  
      try {
        const timebill = record.load({
          type: TIMEBILL_RECORD_TYPE,
          id: timebillId,
          isDynamic: false
        });
  
        if (!timebill.getValue(FIELD.TIME_END)) {
          log.audit('FSM Time Automation skipped', 'Timebill ' + timebillId + ' has no end time.');
          return;
        }
  
        if (isChecked(timebill.getValue(FIELD.PROCESSED))) {
          log.audit('FSM Time Automation skipped', 'Timebill ' + timebillId + ' is already processed.');
          return;
        }
  
        const taskId = timebill.getValue(FIELD.TASK);
        if (!taskId) {
          log.error('FSM Time Automation skipped', 'Timebill ' + timebillId + ' has no task.');
          return;
        }
  
        const task = record.load({
          type: record.Type.TASK,
          id: taskId,
          isDynamic: false
        });
  
        const employeeId = String(timebill.getValue(FIELD.EMPLOYEE) || '');
        const leadTechId = String(task.getValue(FIELD.TASK_LEAD) || '');
        if (!employeeId || employeeId !== leadTechId) {
          log.audit('FSM Time Automation skipped', 'Timebill ' + timebillId + ' was not submitted by the lead tech.');
          return;
        }
  
        const totalHours = toNumber(timebill.getValue(FIELD.HOURS));
        log.audit('FSM Time Automation started', {
          timebillId: timebillId,
          taskId: taskId,
          leadTechId: leadTechId,
          totalHours: totalHours
        });
  
        const splitResult = runOtSplit(timebill, totalHours);
        const sourceTimebillIds = [timebillId].concat(splitResult.createdTimebillIds);
        const teamResult = replicateTeamTime(sourceTimebillIds, task, leadTechId);
        const replicatedCount = teamResult.count;
        const relatedTimeEntryIds = splitResult.createdTimebillIds.concat(teamResult.createdTimebillIds);
        updateOriginalTimebillProcessing(timebillId, relatedTimeEntryIds);
  
        const taskTypeId = String(task.getValue(FIELD.TASK_TYPE) || '');
        if (SHOP_DELIVERY_TASK_TYPES.indexOf(taskTypeId) !== -1) {
          log.audit('FSM Time Automation complete', {
            timebillId: timebillId,
            message: 'Shop/Delivery task. SO work skipped.',
            replicatedCount: replicatedCount,
            relatedTimeEntryIds: relatedTimeEntryIds
          });
          return;
        }
  
        const caseId = task.getValue(FIELD.TASK_CASE);
        if (!caseId) {
          log.error('FSM Time Automation stopped', 'Task ' + taskId + ' has no linked support case.');
          return;
        }
  
        const soInfo = getSalesOrder(task, caseId);
        const salesOrder = soInfo.salesOrder;
        const isOxy = String(task.getValue(FIELD.TASK_CUSTOMER) || '') === OXY_CUSTOMER_ID;
        const config = readConfig();
  
        if (isOxy) {
          addOxyLines(salesOrder, timebill, splitResult, config);
          addEquipmentLines(salesOrder, timebill, config, true);
        } else {
          addOrUpdateLine(salesOrder, config.items.truckTools, totalHours, 'Truck W Tools');
          addLineOnce(salesOrder, config.items.safetyFee, 1, 'Safety Fee');
          addEquipmentLines(salesOrder, timebill, config, false);
          addMileageLine(salesOrder, task, config);
        }
  
        const salesOrderId = salesOrder.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });
  
        if (soInfo.created) {
          logAuditJson('New Sales Order saved JSON', {
            recordType: 'salesorder',
            operation: 'save',
            salesOrderId: salesOrderId,
            caseId: caseId,
            fields: [
              { fieldId: 'entity', value: task.getValue(FIELD.TASK_CUSTOMER) },
              { fieldId: 'subsidiary', value: soInfo.setupValues.subsidiary },
              { fieldId: 'location', value: soInfo.setupValues.location },
              { fieldId: FIELD.SO_ASSET, value: soInfo.setupValues.asset },
              { fieldId: FIELD.SO_CASE, value: soInfo.setupValues.caseId },
              { fieldId: 'job', value: soInfo.setupValues.job }
            ]
          });
          logAuditJson('Case SO writeback JSON', {
            recordType: 'supportcase',
            id: caseId,
            operation: 'submitFields',
            fields: [
              { fieldId: FIELD.CASE_SO, value: salesOrderId }
            ]
          });
          record.submitFields({
            type: record.Type.SUPPORT_CASE,
            id: caseId,
            values: {
              [FIELD.CASE_SO]: salesOrderId
            },
            options: {
              enableSourcing: false,
              ignoreMandatoryFields: true
            }
          });
          log.audit('New Sales Order linked to Case', {
            caseId: caseId,
            salesOrderId: salesOrderId
          });
        }
  
        log.audit('FSM Time Automation complete', {
          timebillId: timebillId,
          salesOrderId: salesOrderId,
          replicatedCount: replicatedCount,
          relatedTimeEntryIds: relatedTimeEntryIds,
          rtHours: splitResult.rtHours,
          otHours: splitResult.otHours
        });
      } catch (e) {
        log.error('FSM Time Automation failed', {
          timebillId: timebillId,
          message: e.message,
          stack: e.stack
        });
        throw e;
      }
    }
  
    function readConfig() {
      return {
        items: getItemsByRole()
      };
    }
  
    function getItemsByRole() {
      const roleItems = {};
      const roleToKey = {
        [ITEM_ROLE.TRUCK_TOOLS]: 'truckTools',
        [ITEM_ROLE.SAFETY_FEE]: 'safetyFee',
        [ITEM_ROLE.MILEAGE]: 'mileage',
        [ITEM_ROLE.MANLIFT]: 'manlift',
        [ITEM_ROLE.GREASE_GUN]: 'greaseGun',
        [ITEM_ROLE.VR_TRAILER]: 'vrTrailer',
        [ITEM_ROLE.OXY_TOOLS_RT]: 'oxyToolsRt',
        [ITEM_ROLE.OXY_TOOLS_OT]: 'oxyToolsOt',
        [ITEM_ROLE.OXY_TRAILER_RT]: 'oxyTrailerRt',
        [ITEM_ROLE.OXY_TRAILER_OT]: 'oxyTrailerOt'
      };
  
      try {
        const roleColumn = search.createColumn({ name: FIELD.ITEM_ROLE });
        const itemRoleLog = [];
        search.create({
          type: search.Type.ITEM,
          filters: [
            ['isinactive', 'is', 'F'],
            'AND',
            [FIELD.ITEM_ROLE, 'anyof', BILLING_ITEM_ROLES]
          ],
          columns: ['internalid', roleColumn]
        }).run().each(function (result) {
          const roleId = String(result.getValue(roleColumn) || '').trim();
          const roleText = String(result.getText(roleColumn) || roleId);
          const key = roleToKey[roleId];
          if (key && !roleItems[key]) {
            const itemId = result.getValue({ name: 'internalid' });
            roleItems[key] = itemId;
            itemRoleLog.push({
              sourceRecordType: 'item',
              sourceFieldId: FIELD.ITEM_ROLE,
              sourceFieldValue: roleId,
              sourceFieldText: roleText,
              resultInternalId: itemId,
              configKey: key
            });
          } else if (key) {
            log.error('Duplicate FSM item role found', 'Role "' + roleText + '" has more than one active item. Using item ' + roleItems[key] + '.');
          }
          return true;
        });
        if (Object.keys(roleItems).length) {
          logAuditJson('FSM item role lookup JSON', {
            searchType: 'item',
            sourceFieldId: FIELD.ITEM_ROLE,
            sourceFieldOperator: 'anyof',
            sourceFieldValues: BILLING_ITEM_ROLES,
            results: itemRoleLog
          });
          log.audit('FSM item roles loaded', {
            itemCount: Object.keys(roleItems).length
          });
        }
      } catch (e) {
        log.error('FSM item role search failed', {
          message: e.message
        });
      }
  
      return roleItems;
    }
  
    function getOtItemId(itemId) {
      try {
        const values = search.lookupFields({
          type: search.Type.ITEM,
          id: itemId,
          columns: [FIELD.ITEM_OT]
        });
        return getLookupId(values[FIELD.ITEM_OT]);
      } catch (e) {
        log.error('OT item lookup failed', {
          itemId: itemId,
          message: e.message
        });
        return '';
      }
    }
  
    function getLookupId(value) {
      if (Array.isArray(value)) {
        return value.length ? String(value[0].value || '') : '';
      }
      return value === null || value === undefined ? '' : String(value);
    }
  
    function runOtSplit(timebill, totalHours) {
      const timebillId = timebill.id;
      const start = timebill.getValue(FIELD.TIME_START);
      const end = timebill.getValue(FIELD.TIME_END);
      const originalItemId = String(timebill.getValue(FIELD.ITEM) || '');
  
      const result = {
        rtHours: totalHours,
        otHours: 0,
        otItemId: '',
        createdTimebillIds: []
      };
  
      if (!start || !end || !originalItemId) {
        log.audit('OT Split skipped', 'Timebill ' + timebillId + ' is missing start, end, or item.');
        return result;
      }
  
      const segments = buildTimeSegments(start, end);
      const hasOt = segments.some(function (segment) {
        return segment.type === 'OT';
      });
  
      if (!hasOt) {
        log.audit('OT Split skipped', 'Timebill ' + timebillId + ' is entirely regular time.');
        return result;
      }
  
      const otItemId = getOtItemId(originalItemId);
      if (!otItemId) {
        log.audit('OT Split skipped', 'No OT item is set on item ' + originalItemId + '.');
        return result;
      }
  
      if (segments.length > 3) {
        log.error('OT Split skipped', 'Timebill ' + timebillId + ' produced more than three segments.');
        return result;
      }
  
      if (segments.length === 1) {
        segments[0].hours = totalHours;
      }
  
      result.rtHours = sumHours(segments, 'RT');
      result.otHours = sumHours(segments, 'OT');
      result.otItemId = otItemId;
  
      const first = segments[0];
      setTimeSegmentValues(timebill, first, originalItemId, otItemId);
      timebill.setValue({ fieldId: FIELD.PROCESSED, value: true });
      const savedOriginalId = timebill.save({
        enableSourcing: true,
        ignoreMandatoryFields: true
      });
  
      const originalSnapshot = getTimebillSnapshot(savedOriginalId);
      for (let i = 1; i < segments.length; i++) {
        const overrides = getTimeSegmentOverrideValues(segments[i], originalItemId, otItemId);
        overrides[FIELD.PROCESSED] = true;
        overrides[FIELD.NX_IDEMPOTENCY_KEY] = '';
        const newId = createTimebillFromSnapshot(originalSnapshot, overrides, 'OT Split');
        result.createdTimebillIds.push(newId);
      }
  
      log.audit('OT Split complete', {
        timebillId: timebillId,
        segments: segments.length,
        rtHours: result.rtHours,
        otHours: result.otHours
      });
  
      return result;
    }
  
    function buildTimeSegments(startValue, endValue) {
      const start = new Date(startValue.getTime());
      const end = new Date(endValue.getTime());
      const points = [start.getTime(), end.getTime()];
  
      let day = new Date(start.getFullYear(), start.getMonth(), start.getDate(), 0, 0, 0, 0);
      while (day.getTime() <= end.getTime()) {
        addPoint(points, new Date(day.getFullYear(), day.getMonth(), day.getDate(), 8, 0, 0, 0), start, end);
        addPoint(points, new Date(day.getFullYear(), day.getMonth(), day.getDate(), 17, 0, 0, 0), start, end);
        addPoint(points, new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0), start, end);
        day = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1, 0, 0, 0, 0);
      }
  
      points.sort(function (a, b) {
        return a - b;
      });
  
      const segments = [];
      for (let i = 0; i < points.length - 1; i++) {
        if (points[i] === points[i + 1]) {
          continue;
        }
        const segmentStart = new Date(points[i]);
        const segmentEnd = new Date(points[i + 1]);
        segments.push({
          start: segmentStart,
          end: segmentEnd,
          hours: roundHours((segmentEnd.getTime() - segmentStart.getTime()) / 3600000),
          type: getTimeType(segmentStart, segmentEnd)
        });
      }
      return segments;
    }
  
    function addPoint(points, point, start, end) {
      const value = point.getTime();
      if (value > start.getTime() && value < end.getTime() && points.indexOf(value) === -1) {
        points.push(value);
      }
    }
  
    function getTimeType(start, end) {
      const midpoint = new Date((start.getTime() + end.getTime()) / 2);
      const rtStart = new Date(midpoint.getFullYear(), midpoint.getMonth(), midpoint.getDate(), 8, 0, 0, 0);
      const rtEnd = new Date(midpoint.getFullYear(), midpoint.getMonth(), midpoint.getDate(), 17, 0, 0, 0);
      return midpoint.getTime() >= rtStart.getTime() && midpoint.getTime() <= rtEnd.getTime() ? 'RT' : 'OT';
    }
  
    function setTimeSegmentValues(timebill, segment, originalItemId, otItemId) {
      timebill.setValue({ fieldId: FIELD.HOURS, value: segment.hours });
      timebill.setValue({ fieldId: FIELD.TIME_START, value: segment.start });
      timebill.setValue({ fieldId: FIELD.TIME_END, value: segment.end });
      timebill.setValue({ fieldId: FIELD.ITEM, value: segment.type === 'OT' ? otItemId : originalItemId });
    }
  
    function getTimeSegmentOverrideValues(segment, originalItemId, otItemId) {
      const values = {};
      values[FIELD.HOURS] = segment.hours;
      values[FIELD.TIME_START] = segment.start;
      values[FIELD.TIME_END] = segment.end;
      values[FIELD.ITEM] = segment.type === 'OT' ? otItemId : originalItemId;
      return values;
    }
  
    function replicateTeamTime(sourceTimebillIds, task, leadTechId) {
      const teamMembers = toArray(task.getValue(FIELD.TASK_TEAM));
      let count = 0;
      const createdTimebillIds = [];
      const createdTimebillLinks = [];
  
      if (!teamMembers.length) {
        log.audit('Team replication skipped', 'No team members on task ' + task.id + '.');
        return {
          count: count,
          createdTimebillIds: createdTimebillIds
        };
      }
  
      for (let i = 0; i < sourceTimebillIds.length; i++) {
        const sourceTimebillId = sourceTimebillIds[i];
        const sourceSnapshot = getTimebillSnapshot(sourceTimebillId);
        for (let j = 0; j < teamMembers.length; j++) {
          const employeeId = String(teamMembers[j] || '');
          if (!employeeId || employeeId === String(leadTechId)) {
            continue;
          }
  
          const overrides = {};
          overrides[FIELD.EMPLOYEE] = employeeId;
          overrides[FIELD.PROCESSED] = true;
          overrides[FIELD.NX_IDEMPOTENCY_KEY] = '';
          const newTimebillId = createTimebillFromSnapshot(sourceSnapshot, overrides, 'Team replication');
          createdTimebillIds.push(newTimebillId);
          createdTimebillLinks.push({
            sourceTimebillId: sourceTimebillId,
            newTimebillId: newTimebillId,
            employeeId: employeeId,
            creationMethod: 'record.create from source field values',
            mappedFields: sourceSnapshot.fieldIds,
            overriddenFields: [
              { fieldId: FIELD.EMPLOYEE, value: employeeId },
              { fieldId: FIELD.PROCESSED, value: true },
              { fieldId: FIELD.NX_IDEMPOTENCY_KEY, value: '' }
            ]
          });
          count++;
        }
      }
  
      logAuditJson('Team replication create JSON', {
        recordType: TIMEBILL_RECORD_TYPE,
        taskId: task.id,
        sourceCount: sourceTimebillIds.length,
        sourceTimebillIds: sourceTimebillIds,
        replicatedCount: count,
        createdTimebillIds: createdTimebillIds,
        createdTimebillLinks: createdTimebillLinks
      });
  
      return {
        count: count,
        createdTimebillIds: createdTimebillIds
      };
    }
  
    function getTimebillSnapshot(timebillId) {
      const sourceTimebill = record.load({
        type: TIMEBILL_RECORD_TYPE,
        id: timebillId,
        isDynamic: false
      });
      const values = {};
      const skippedReadFields = [];
      const fieldIds = [];
  
      for (let i = 0; i < TIMEBILL_SNAPSHOT_FIELDS.length; i++) {
        const fieldId = TIMEBILL_SNAPSHOT_FIELDS[i];
        try {
          const value = sourceTimebill.getValue({ fieldId: fieldId });
          if (value !== null && value !== undefined && value !== '') {
            values[fieldId] = value;
            fieldIds.push(fieldId);
          }
        } catch (e) {
          skippedReadFields.push({
            fieldId: fieldId,
            message: e.message
          });
        }
      }
  
      return {
        sourceTimebillId: timebillId,
        values: values,
        fieldIds: fieldIds,
        skippedReadFields: skippedReadFields
      };
    }
  
    function createTimebillFromSnapshot(snapshot, overrides, label) {
      const newTimebill = record.create({
        type: TIMEBILL_RECORD_TYPE,
        isDynamic: false
      });
      const skippedSetFields = [];
      const mappedFields = [];
      const overrideFields = [];


      log.debug('snapshot', snapshot)
      log.debug('overrides', overrides)
  
      for (let i = 0; i < snapshot.fieldIds.length; i++) {
        const fieldId = snapshot.fieldIds[i];
        try {
          newTimebill.setValue({
            fieldId: fieldId,
            value: snapshot.values[fieldId]
          });
          mappedFields.push({
            fieldId: fieldId,
            value: snapshot.values[fieldId]
          });
        } catch (e) {
          skippedSetFields.push({
            fieldId: fieldId,
            message: e.message
          });
        }
      }
  
      const overrideIds = Object.keys(overrides || {});
      for (let j = 0; j < overrideIds.length; j++) {
        const overrideFieldId = overrideIds[j];
        try {
          newTimebill.setValue({
            fieldId: overrideFieldId,
            value: overrides[overrideFieldId]
          });
          overrideFields.push({
            fieldId: overrideFieldId,
            value: overrides[overrideFieldId]
          });
        } catch (e) {
          skippedSetFields.push({
            fieldId: overrideFieldId,
            value: overrides[overrideFieldId],
            message: e.message
          });
        }
      }
  
      const createLog = {
        recordType: TIMEBILL_RECORD_TYPE,
        sourceTimebillId: snapshot.sourceTimebillId,
        creationMethod: 'record.create from source field values',
        mappedFields: mappedFields,
        skippedReadFields: snapshot.skippedReadFields,
        skippedSetFields: skippedSetFields,
        overriddenFields: overrideFields
      };
  
      logAuditJson(label + ' timebill create attempt JSON', createLog);
  
      let newTimebillId;
      try {
        newTimebillId = newTimebill.save({
          enableSourcing: true,
          ignoreMandatoryFields: true
        });
      } catch (e) {
        createLog.message = e.message;
        log.error(label + ' timebill create failed JSON', JSON.stringify(createLog));
        throw e;
      }
  
      createLog.newTimebillId = newTimebillId;
      logAuditJson(label + ' timebill created JSON', createLog);
  
      return newTimebillId;
    }
  
    function updateOriginalTimebillProcessing(timebillId, relatedTimeEntryIds) {
      const relatedValue = (relatedTimeEntryIds || []).join(',');
      logAuditJson('Related time entries writeback JSON', {
        recordType: TIMEBILL_RECORD_TYPE,
        id: timebillId,
        operation: 'submitFields',
        fields: [
          { fieldId: FIELD.PROCESSED, value: true },
          { fieldId: FIELD.RELATED_TIME_ENTRIES, value: relatedValue }
        ],
        relatedTimeEntryIds: relatedTimeEntryIds || []
      });
  
      record.submitFields({
        type: TIMEBILL_RECORD_TYPE,
        id: timebillId,
        values: {
          [FIELD.PROCESSED]: true,
          [FIELD.RELATED_TIME_ENTRIES]: relatedValue
        },
        options: {
          enableSourcing: false,
          ignoreMandatoryFields: true
        }
      });
    }
  
    function getSalesOrder(task, caseId) {
      const supportCase = record.load({
        type: record.Type.SUPPORT_CASE,
        id: caseId,
        isDynamic: false
      });
      const existingSalesOrderId = supportCase.getValue(FIELD.CASE_SO);
      const setupValues = {
        customer: task.getValue(FIELD.TASK_CUSTOMER),
        trandate: new Date(),
        subsidiary: supportCase.getValue(FIELD.CASE_SUBSIDIARY),
        location: 1,
        asset: task.getValue(FIELD.TASK_ASSET),
        caseId: caseId,
        job: task.getValue(FIELD.TASK_JOB)
      };
  
      if (existingSalesOrderId) {
        log.audit('Sales Order found', {
          caseId: caseId,
          existingSalesOrderId: existingSalesOrderId,
          taskCustomerId: setupValues.customer,
          taskAssetId: setupValues.asset,
          taskJobId: setupValues.job
        });
        return {
          salesOrder: record.load({
            type: record.Type.SALES_ORDER,
            id: existingSalesOrderId,
            isDynamic: true
          }),
          created: false,
          setupValues: setupValues
        };
      }
  
      const salesOrder = record.create({
        type: record.Type.SALES_ORDER,
        isDynamic: true
      });
  
      logAuditJson('New Sales Order setup field JSON', {
        recordType: 'salesorder',
        operation: 'create',
        fields: [
          { fieldId: 'entity', value: setupValues.customer },
          { fieldId: 'trandate', value: setupValues.trandate },
          { fieldId: 'subsidiary', value: setupValues.subsidiary },
          { fieldId: 'location', value: setupValues.location },
          { fieldId: FIELD.SO_ASSET, value: setupValues.asset },
          { fieldId: FIELD.SO_CASE, value: setupValues.caseId },
          { fieldId: 'job', value: setupValues.job }
        ]
      });
  
      setIfValue(salesOrder, 'entity', setupValues.customer);
      setIfValue(salesOrder, 'trandate', setupValues.trandate);
      setIfValue(salesOrder, 'subsidiary', setupValues.subsidiary);
      setIfValue(salesOrder, 'location', setupValues.location);
      setIfValue(salesOrder, FIELD.SO_ASSET, setupValues.asset);
      setIfValue(salesOrder, FIELD.SO_CASE, setupValues.caseId);
      setIfValue(salesOrder, 'job', setupValues.job);
  
      log.audit('Sales Order created in memory', 'New SO will be saved after line updates.');
      return {
        salesOrder: salesOrder,
        created: true,
        setupValues: setupValues
      };
    }
  
    function addOxyLines(salesOrder, timebill, splitResult, config) {
      const hasTrailer = readCheckbox(timebill, FIELD.VR_TRAILER);
      const rtItem = hasTrailer ? config.items.oxyTrailerRt : config.items.oxyToolsRt;
      const otItem = hasTrailer ? config.items.oxyTrailerOt : config.items.oxyToolsOt;
  
      if (splitResult.rtHours > 0) {
        addOrUpdateLine(salesOrder, rtItem, splitResult.rtHours, 'Oxy RT Day Rate');
      }
      if (splitResult.otHours > 0) {
        addOrUpdateLine(salesOrder, otItem, splitResult.otHours, 'Oxy OT Day Rate');
      }
    }
  
    function addEquipmentLines(salesOrder, timebill, config, isOxy) {
      if (readCheckbox(timebill, FIELD.MANLIFT)) {
        addLineOnce(salesOrder, config.items.manlift, 1, 'Manlift');
      }
      if (readCheckbox(timebill, FIELD.GREASE_GUN)) {
        addLineOnce(salesOrder, config.items.greaseGun, 1, 'Grease Gun');
      }
      if (!isOxy && readCheckbox(timebill, FIELD.VR_TRAILER)) {
        addLineOnce(salesOrder, config.items.vrTrailer, 1, 'VR Trailer');
      }
    }
  
    function addMileageLine(salesOrder, task, config) {
      let distance = 0;
      const assetId = task.getValue(FIELD.TASK_ASSET);
  
      if (assetId) {
        try {
          const asset = record.load({
            type: ASSET_RECORD_TYPE,
            id: assetId,
            isDynamic: false
          });
          distance = toNumber(asset.getValue(FIELD.ASSET_DISTANCE));
        } catch (e) {
          log.error('Mileage asset load failed', {
            assetId: assetId,
            assetRecordType: ASSET_RECORD_TYPE,
            message: e.message
          });
        }
      }
  
      addLineOnce(salesOrder, config.items.mileage, distance, 'Mileage');
    }
  
    function addOrUpdateLine(salesOrder, itemId, quantity, label) {
      if (!itemId) {
        log.error(label + ' skipped', 'Item is not configured.');
        return;
      }
  
      const line = findItemLine(salesOrder, itemId);
      if (line >= 0) {
        const existingQuantity = toNumber(salesOrder.getSublistValue({
          sublistId: 'item',
          fieldId: 'quantity',
          line: line
        }));
        const newQuantity = roundHours(existingQuantity + toNumber(quantity));
        const lineFields = [
          { fieldId: 'quantity', value: newQuantity }
        ];
        salesOrder.selectLine({ sublistId: 'item', line: line });
        salesOrder.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'quantity',
          value: newQuantity
        });
        const rateInfo = setFallbackRateIfMissing(salesOrder, lineFields, label);
        logAuditJson('SO item line field JSON', {
          label: label,
          recordType: 'salesorder',
          sublistId: 'item',
          operation: 'update existing line',
          line: line,
          match: {
            fieldId: 'item',
            value: itemId
          },
          fields: lineFields,
          calculation: {
            existingQuantity: existingQuantity,
            quantityToAdd: toNumber(quantity),
            newQuantity: newQuantity
          },
          rateInfo: rateInfo
        });
        salesOrder.commitLine({ sublistId: 'item' });
        log.audit(label + ' updated', 'Added quantity ' + quantity + ' to existing line.');
        return;
      }
  
      const lineFields = [
        { fieldId: 'item', value: itemId },
        { fieldId: 'quantity', value: toNumber(quantity) }
      ];
      salesOrder.selectNewLine({ sublistId: 'item' });
      salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
      salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: toNumber(quantity) });
      const rateInfo = setFallbackRateIfMissing(salesOrder, lineFields, label);
      logAuditJson('SO item line field JSON', {
        label: label,
        recordType: 'salesorder',
        sublistId: 'item',
        operation: 'add new line',
        fields: lineFields,
        rateInfo: rateInfo
      });
      salesOrder.commitLine({ sublistId: 'item' });
      log.audit(label + ' added', 'Quantity ' + quantity + '.');
    }
  
    function addLineOnce(salesOrder, itemId, quantity, label) {
      if (!itemId) {
        log.error(label + ' skipped', 'Item is not configured.');
        return;
      }
  
      const line = findItemLine(salesOrder, itemId);
      if (line >= 0) {
        logAuditJson('SO item line skipped JSON', {
          label: label,
          recordType: 'salesorder',
          sublistId: 'item',
          operation: 'skip existing line',
          line: line,
          match: {
            fieldId: 'item',
            value: itemId
          }
        });
        log.audit(label + ' skipped', 'Line already exists.');
        return;
      }
  
      const lineFields = [
        { fieldId: 'item', value: itemId },
        { fieldId: 'quantity', value: toNumber(quantity) }
      ];
      salesOrder.selectNewLine({ sublistId: 'item' });
      salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: itemId });
      salesOrder.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: toNumber(quantity) });
      const rateInfo = setFallbackRateIfMissing(salesOrder, lineFields, label);
      logAuditJson('SO item line field JSON', {
        label: label,
        recordType: 'salesorder',
        sublistId: 'item',
        operation: 'add new line',
        fields: lineFields,
        rateInfo: rateInfo
      });
      salesOrder.commitLine({ sublistId: 'item' });
      log.audit(label + ' added', 'Quantity ' + quantity + '.');
    }
  
    function setFallbackRateIfMissing(salesOrder, lineFields, label) {
      const sourcedRate = salesOrder.getCurrentSublistValue({
        sublistId: 'item',
        fieldId: 'rate'
      });
  
      if (hasUsableRate(sourcedRate)) {
        return {
          fallbackApplied: false,
          sourcedRate: sourcedRate
        };
      }
  
      try {
        salesOrder.setCurrentSublistValue({
          sublistId: 'item',
          fieldId: 'price',
          value: -1
        });
        lineFields.push({ fieldId: 'price', value: -1 });
      } catch (e) {
        log.audit(label + ' custom price level skipped', {
          message: e.message
        });
      }
  
      salesOrder.setCurrentSublistValue({
        sublistId: 'item',
        fieldId: 'rate',
        value: FALLBACK_TEST_RATE
      });
      lineFields.push({ fieldId: 'rate', value: FALLBACK_TEST_RATE });
  
      return {
        fallbackApplied: true,
        sourcedRate: sourcedRate,
        fallbackRate: FALLBACK_TEST_RATE
      };
    }
  
    function hasUsableRate(value) {
      if (value === null || value === undefined || value === '') {
        return false;
      }
      return toNumber(value) !== 0;
    }
  
    function findItemLine(salesOrder, itemId) {
      const lineCount = salesOrder.getLineCount({ sublistId: 'item' });
      for (let i = 0; i < lineCount; i++) {
        const currentItemId = String(salesOrder.getSublistValue({
          sublistId: 'item',
          fieldId: 'item',
          line: i
        }) || '');
        if (currentItemId === String(itemId)) {
          return i;
        }
      }
      return -1;
    }
  
    function readCheckbox(rec, fieldId) {
      if (!fieldId) {
        return false;
      }
      return isChecked(rec.getValue(fieldId));
    }
  
    function setIfValue(rec, fieldId, value) {
      if (value !== null && value !== undefined && value !== '') {
        rec.setValue({ fieldId: fieldId, value: value });
      }
    }
  
    function logAuditJson(title, details) {
      log.audit(title, JSON.stringify(details));
    }
  
    function toArray(value) {
      if (!value) {
        return [];
      }
      return Array.isArray(value) ? value : [value];
    }
  
    function toNumber(value) {
      const numberValue = parseFloat(value);
      return isNaN(numberValue) ? 0 : numberValue;
    }
  
    function roundHours(value) {
      return Math.round(toNumber(value) * 10000) / 10000;
    }
  
    function sumHours(segments, type) {
      return roundHours(segments.reduce(function (total, segment) {
        return total + (segment.type === type ? segment.hours : 0);
      }, 0));
    }
  
    function isChecked(value) {
      return value === true || value === 'T';
    }
  
    return {
      afterSubmit: afterSubmit
    };
  });
  