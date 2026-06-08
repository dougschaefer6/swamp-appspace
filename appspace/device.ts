import { z } from "npm:zod@4.3.6";
import {
  appspaceApi,
  AppspaceGlobalArgsSchema,
  appspacePaged,
  sanitizeId,
} from "./_client.ts";

const DeviceSchema = z.object({
  id: z.string(),
  name: z.string(),
  deviceType: z.string().optional(),
  locationId: z.string().nullable().optional(),
  locationName: z.string().nullable().optional(),
  groupId: z.string().nullable().optional(),
  groupName: z.string().nullable().optional(),
  status: z.string().optional(),
  appVersion: z.string().optional(),
  lastOnlineAt: z.string().optional(),
  channelId: z.string().nullable().optional(),
  channelName: z.string().nullable().optional(),
  ipAddress: z.string().optional(),
  macAddress: z.string().optional(),
  appUpdateStatus: z.string().optional(),
}).passthrough();

const DeviceGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
}).passthrough();

const DevicePropertiesSchema = z.object({
  deviceId: z.string(),
  properties: z.record(z.string(), z.unknown()),
}).passthrough();

const TaskDeploymentSchema = z.object({
  id: z.string().optional(),
  taskTemplateId: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

/**
 * `@dougschaefer/appspace-device` model — manage Appspace player devices on
 * a tenant. Covers listing, status reporting, device properties (get/set/
 * delete, case-sensitive lowercase keys), one-shot commands (reboot,
 * refresh, screenshot), pre-deployed integrations, and asynchronous task
 * deployments with response polling. Property writes and command sends
 * propagate through Appspace's device messaging bus.
 */
export const model = {
  type: "@dougschaefer/appspace-device",
  version: "2026.06.08.1",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    device: {
      description:
        "Appspace-managed display device with location, group, channel, and runtime status",
      schema: DeviceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deviceGroup: {
      description: "Group of Appspace devices for batch operations",
      schema: DeviceGroupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deviceProperties: {
      description:
        "Player Properties for a specific device (used for per-device card overrides like API credentials)",
      schema: DevicePropertiesSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    taskDeployment: {
      description:
        "Task deployed to a device, group, or location (firmware update, command, etc.)",
      schema: TaskDeploymentSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "api-reachable": {
      description:
        "Verify the Appspace API is reachable and credentials are valid before executing impactful device operations.",
      labels: ["live"],
      appliesTo: ["sendCommand", "createTaskDeployment"],
      execute: async (context) => {
        try {
          await appspaceApi("/api/v3/users/me", context.globalArgs);
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [
              `Appspace API not reachable or credentials invalid: ${
                String(err)
              }`,
            ],
          };
        }
      },
    },
  },

  methods: {
    list: {
      description:
        "Query devices with optional filtering. Pages through results automatically.",
      arguments: z.object({
        locationId: z.string().optional().describe(
          "Filter by location ID",
        ),
        groupId: z.string().optional().describe("Filter by device group ID"),
        status: z.string().optional().describe(
          "Filter by status (Online, Offline, etc.)",
        ),
        maxItems: z.number().optional().default(500).describe(
          "Maximum devices to return",
        ),
      }),
      execute: async (args, context) => {
        const params: Record<string, string | number> = {};
        if (args.locationId) params.locationId = args.locationId;
        if (args.groupId) params.groupId = args.groupId;
        if (args.status) params.status = args.status;

        const devices = await appspacePaged(
          "/api/v3/devices",
          context.globalArgs,
          {
            params,
            maxItems: args.maxItems,
          },
        );

        context.logger.info("Found {count} devices", { count: devices.length });

        const handles = [];
        for (const d of devices) {
          const name = sanitizeId((d.name as string) || (d.id as string));
          const handle = await context.writeResource("device", name, d);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get details for a specific device by ID.",
      arguments: z.object({
        id: z.string().describe("Device ID (UUID)"),
      }),
      execute: async (args, context) => {
        const device = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.id)}`,
          context.globalArgs,
        ) as Record<string, unknown>;

        const name = sanitizeId((device.name as string) || args.id);
        const handle = await context.writeResource("device", name, device);
        return { dataHandles: [handle] };
      },
    },

    getStatuses: {
      description:
        "Query live status for devices (online/offline, sync state, etc.).",
      arguments: z.object({
        deviceIds: z.array(z.string()).optional().describe(
          "Optional list of device IDs to filter on",
        ),
      }),
      execute: async (args, context) => {
        const params: Record<string, string> = {};
        if (args.deviceIds && args.deviceIds.length > 0) {
          params.deviceIds = args.deviceIds.join(",");
        }
        const statuses = await appspaceApi(
          "/api/v3/devices/devicestatuses",
          context.globalArgs,
          { params },
        );
        return {
          data: {
            attributes: { statuses },
            name: "device-statuses",
          },
        };
      },
    },

    getProperties: {
      description:
        "Get all Player Properties for a device. These are key/value pairs used to override card configuration per device (e.g., API credentials, datasourceurl).",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
      }),
      execute: async (args, context) => {
        const props = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/properties`,
          context.globalArgs,
        ) as Record<string, unknown>;

        const handle = await context.writeResource(
          "deviceProperties",
          sanitizeId(args.deviceId),
          { deviceId: args.deviceId, properties: props },
        );
        return { dataHandles: [handle] };
      },
    },

    setProperties: {
      description:
        "Upsert one or more Player Properties on a device. Property names must be lowercase and case-sensitive.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        properties: z.record(z.string(), z.string()).describe(
          "Map of property name (lowercase) → value",
        ),
      }),
      execute: async (args, context) => {
        const body = Object.entries(args.properties).map(([name, value]) => ({
          name,
          value,
        }));
        await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/properties`,
          context.globalArgs,
          { method: "PUT", body },
        );
        context.logger.info(
          "Updated {count} properties on device {deviceId}",
          { count: body.length, deviceId: args.deviceId },
        );
        // Re-fetch current properties so the resource reflects actual state.
        const props = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/properties`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "deviceProperties",
          sanitizeId(args.deviceId),
          { deviceId: args.deviceId, properties: props },
        );
        return { dataHandles: [handle] };
      },
    },

    deleteProperties: {
      description: "Remove specific Player Properties from a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        propertyNames: z.array(z.string()).describe(
          "Property names to delete",
        ),
      }),
      execute: async (args, context) => {
        await appspaceApi(
          `/api/v3/devices/${
            encodeURIComponent(args.deviceId)
          }/properties/delete`,
          context.globalArgs,
          { method: "POST", body: args.propertyNames },
        );
        // Re-fetch current properties so the resource reflects actual state.
        const props = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/properties`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "deviceProperties",
          sanitizeId(args.deviceId),
          { deviceId: args.deviceId, properties: props },
        );
        return { dataHandles: [handle] };
      },
    },

    sendCommand: {
      description:
        "Send a command to a device (restart, reload, screenshot, etc.). Available commands depend on device type.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        command: z.string().describe(
          "Command name (e.g., 'restart', 'reload', 'screenshot')",
        ),
        parameters: z.record(z.string(), z.unknown()).optional().describe(
          "Optional command parameters",
        ),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/command`,
          context.globalArgs,
          {
            method: "POST",
            body: { command: args.command, parameters: args.parameters ?? {} },
          },
        );
        context.logger.info("Sent command {cmd} to device {id}", {
          cmd: args.command,
          id: args.deviceId,
        });
        return {
          data: {
            attributes: {
              deviceId: args.deviceId,
              command: args.command,
              result,
            },
            name: `cmd-${args.command}-${sanitizeId(args.deviceId)}`,
          },
        };
      },
    },

    getConfiguration: {
      description: "Get the runtime configuration for a device.",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
      }),
      execute: async (args, context) => {
        const config = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/configuration`,
          context.globalArgs,
        );
        return {
          data: {
            attributes: { deviceId: args.deviceId, configuration: config },
            name: `config-${sanitizeId(args.deviceId)}`,
          },
        };
      },
    },

    screenCapture: {
      description:
        "Get the latest screen capture URL for a device (only available for devices with screencapture capability).",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
      }),
      execute: async (args, context) => {
        const capture = await appspaceApi(
          `/api/v3/devices/${encodeURIComponent(args.deviceId)}/screencapture`,
          context.globalArgs,
        );
        return {
          data: {
            attributes: { deviceId: args.deviceId, capture },
            name: `screen-${sanitizeId(args.deviceId)}`,
          },
        };
      },
    },

    listGroups: {
      description: "List all device groups.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const groups = await appspacePaged(
          "/api/v3/devices/devicegroups",
          context.globalArgs,
        );
        context.logger.info("Found {count} device groups", {
          count: groups.length,
        });
        const handles = [];
        for (const g of groups) {
          const name = sanitizeId((g.name as string) || (g.id as string));
          const handle = await context.writeResource("deviceGroup", name, g);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    sync: {
      description:
        "Trigger a content sync on one or more devices (push channel/playlist updates).",
      arguments: z.object({
        deviceIds: z.array(z.string()).describe("Device IDs to sync"),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          "/api/v3/devices/sync",
          context.globalArgs,
          { method: "POST", body: { deviceIds: args.deviceIds } },
        );
        context.logger.info("Triggered sync on {count} devices", {
          count: args.deviceIds.length,
        });
        return {
          data: {
            attributes: { deviceIds: args.deviceIds, result },
            name: "sync-result",
          },
        };
      },
    },

    listIntegrations: {
      description:
        "List third-party device integrations configured for the account (e.g., Crestron Fusion, Cisco Webex).",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const integrations = await appspaceApi(
          "/api/v3/devices/integrations",
          context.globalArgs,
        );
        return {
          data: {
            attributes: { integrations },
            name: "integrations",
          },
        };
      },
    },

    listTaskDeployments: {
      description:
        "Query task deployments (firmware updates, configuration pushes, etc.) by location, device, or group.",
      arguments: z.object({
        locationId: z.string().optional(),
        deviceId: z.string().optional(),
        deviceGroupId: z.string().optional(),
      }),
      execute: async (args, context) => {
        const params: Record<string, string> = {};
        if (args.locationId) params.locationId = args.locationId;
        if (args.deviceId) params.deviceId = args.deviceId;
        if (args.deviceGroupId) params.deviceGroupId = args.deviceGroupId;

        const deployments = await appspaceApi(
          "/api/v3/devices/tasks/deployments",
          context.globalArgs,
          { params },
        ) as { items?: Array<Record<string, unknown>> } | null;

        const items = deployments?.items ?? [];
        const handles = [];
        for (const dep of items) {
          const name = sanitizeId((dep.id as string) ?? "deployment");
          const handle = await context.writeResource(
            "taskDeployment",
            name,
            dep,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    createTaskDeployment: {
      description:
        "Deploy a task (firmware update, configuration, command) to one or more targets.",
      arguments: z.object({
        taskTemplateId: z.string().describe("Task template ID to deploy"),
        targetType: z.enum(["device", "deviceGroup", "location"]).describe(
          "What to target",
        ),
        targetIds: z.array(z.string()).describe("IDs of targets"),
        scheduledAt: z.string().optional().describe(
          "ISO 8601 datetime to schedule the deployment (defaults to immediate)",
        ),
      }),
      execute: async (args, context) => {
        const body: Record<string, unknown> = {
          taskTemplateId: args.taskTemplateId,
          targetType: args.targetType,
          targetIds: args.targetIds,
        };
        if (args.scheduledAt) body.scheduledAt = args.scheduledAt;

        let result: Record<string, unknown>;
        try {
          result = await appspaceApi(
            "/api/v3/devices/tasks/deployments",
            context.globalArgs,
            { method: "POST", body },
          ) as Record<string, unknown>;
          context.logger.info(
            "Deployed task {tmpl} to {count} {type}(s)",
            {
              tmpl: args.taskTemplateId,
              count: args.targetIds.length,
              type: args.targetType,
            },
          );
        } catch (e) {
          const msg = (e as Error).message;
          if (!msg.includes("409")) throw e;
          // Already deployed — converge by returning existing deployment info.
          context.logger.info(
            "Task deployment for {tmpl} already exists — converging",
            { tmpl: args.taskTemplateId },
          );
          result = {
            status: "already_exists",
            taskTemplateId: args.taskTemplateId,
          };
        }

        const id = (result.id as string) ?? sanitizeId(args.taskTemplateId);
        const handle = await context.writeResource(
          "taskDeployment",
          sanitizeId(id),
          { taskTemplateId: args.taskTemplateId, ...result },
        );
        return { dataHandles: [handle] };
      },
    },

    getTaskResponses: {
      description:
        "Get task execution responses for a device (results of firmware updates, command executions, etc.).",
      arguments: z.object({
        deviceId: z.string().describe("Device ID"),
        taskClass: z.string().optional().describe(
          "Optional task class filter",
        ),
      }),
      execute: async (args, context) => {
        const params: Record<string, string> = { deviceId: args.deviceId };
        if (args.taskClass) params.taskClass = args.taskClass;

        const responses = await appspaceApi(
          "/api/v3/devices/tasks/responses",
          context.globalArgs,
          { params },
        );
        return {
          data: {
            attributes: { deviceId: args.deviceId, responses },
            name: `task-responses-${sanitizeId(args.deviceId)}`,
          },
        };
      },
    },
  },
};
