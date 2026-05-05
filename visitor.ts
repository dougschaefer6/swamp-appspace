import { z } from "npm:zod@4.3.6";
import {
  appspaceApi,
  AppspaceGlobalArgsSchema,
  appspacePaged,
  sanitizeId,
} from "./_client.ts";

const VisitorSchema = z.object({
  id: z.string(),
  firstName: z.string().optional(),
  lastName: z.string().optional(),
  fullName: z.string().optional(),
  email: z.string().optional(),
  visitorType: z.string().optional(),
  customFields: z.array(z.record(z.string(), z.unknown())).optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  visitorRegistrationStatus: z.string().optional(),
  lastVisit: z.record(z.string(), z.unknown()).optional(),
}).passthrough();

const VisitorConfigurationSchema = z.object({
  isVisitorPhotoRequired: z.boolean().optional(),
  isVisitorEmailRequired: z.boolean().optional(),
  isHostPrivacyEnabled: z.boolean().optional(),
  visitorFields: z.array(z.unknown()).optional(),
  visitorPurposes: z.array(z.unknown()).optional(),
  visitorTypes: z.array(z.unknown()).optional(),
  notification: z.record(z.string(), z.unknown()).optional(),
  retentionPolicies: z.unknown().optional(),
}).passthrough();

const InvitationSchema = z.object({
  id: z.string().optional(),
  type: z.string().optional(),
  title: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  hosts: z.array(z.record(z.string(), z.unknown())).optional(),
  visitors: z.array(z.record(z.string(), z.unknown())).optional(),
  resourceIds: z.array(z.string()).optional(),
}).passthrough();

/**
 * `@dougschaefer/appspace-visitor` model — visitor management lifecycle on
 * Appspace Cloud. Covers visitor records (list, get, create, delete),
 * configuration, drop-in invitations (the kiosk walk-in / procurement
 * flow), event listing for a visitor, and check-in / check-out actions.
 * Bare `createVisitor` does NOT trigger host notifications; pair with a
 * DropIn invitation against a host UUID to fire Appspace's configured
 * notification routing (Teams Passport, in-app push, Concierge, email).
 */
export const model = {
  type: "@dougschaefer/appspace-visitor",
  version: "2026.04.27.1",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    visitor: {
      description: "Visitor record in the Appspace Visitor Management system",
      schema: VisitorSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    visitorConfiguration: {
      description:
        "Visitor Management configuration for the account — required fields, custom field definitions, visit purposes, types, retention, and notification settings (the rules that drive Teams Passport / push / email routing)",
      schema: VisitorConfigurationSchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
    invitation: {
      description:
        "Visitor invitation — links visitors to hosts/resources and triggers Appspace's notification chain (Teams Passport bot, in-app push, Concierge, email)",
      schema: InvitationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "Query the visitor list with optional filtering.",
      arguments: z.object({
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const visitors = await appspacePaged(
          "/api/v3/visitormanagement/visitors",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        context.logger.info("Found {count} visitors", {
          count: visitors.length,
        });
        const handles = [];
        for (const v of visitors) {
          const name = sanitizeId(
            (v.email as string) ?? (v.id as string) ?? "visitor",
          );
          const handle = await context.writeResource("visitor", name, v);
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a specific visitor by ID.",
      arguments: z.object({
        id: z.string().describe("Visitor UUID"),
      }),
      execute: async (args, context) => {
        const v = await appspaceApi(
          `/api/v3/visitormanagement/visitors/${encodeURIComponent(args.id)}`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const name = sanitizeId(
          (v.email as string) ?? (v.id as string) ?? args.id,
        );
        const handle = await context.writeResource("visitor", name, v);
        return { dataHandles: [handle] };
      },
    },

    create: {
      description:
        "Create a visitor record. Required: firstName, lastName, email, visitorType. customFields must be empty array unless the account has custom visitor fields configured. Note: bare visitor creation does NOT trigger the host-notification chain — pair with createDropInInvitation for walk-in workflows.",
      arguments: z.object({
        firstName: z.string(),
        lastName: z.string(),
        email: z.string(),
        visitorType: z.string().default("Guest").describe(
          "Visitor type label — free-form string. Defaults to 'Guest'.",
        ),
        customFields: z.array(z.object({
          id: z.string(),
          value: z.string(),
        })).default([]).describe(
          "Custom field values. Field IDs must be pre-configured in /visitormanagement/configurations/me/visitorfields.",
        ),
      }),
      execute: async (args, context) => {
        const body = {
          firstName: args.firstName,
          lastName: args.lastName,
          email: args.email,
          visitorType: args.visitorType,
          customFields: args.customFields,
        };
        const created = await appspaceApi(
          "/api/v3/visitormanagement/visitors",
          context.globalArgs,
          { method: "POST", body },
        ) as Record<string, unknown>;
        context.logger.info(
          "Created visitor {id}: {name}",
          { id: created.id, name: created.fullName ?? args.email },
        );
        const handle = await context.writeResource(
          "visitor",
          sanitizeId(args.email),
          created,
        );
        return { dataHandles: [handle] };
      },
    },

    delete: {
      description: "Delete a visitor by ID.",
      arguments: z.object({
        id: z.string().describe("Visitor UUID"),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/visitormanagement/visitors/${encodeURIComponent(args.id)}`,
          context.globalArgs,
          { method: "DELETE" },
        );
        context.logger.info("Deleted visitor {id}", { id: args.id });
        return {
          data: {
            attributes: { id: args.id, result },
            name: `delete-${sanitizeId(args.id)}`,
          },
        };
      },
    },

    getConfiguration: {
      description:
        "Get the account's Visitor Management configuration — required fields, custom field definitions, visit purposes, visitor types, retention, and the notification config block that controls Teams Passport / Appspace app push / email routing.",
      arguments: z.object({}),
      execute: async (_args, context) => {
        const config = await appspaceApi(
          "/api/v3/visitormanagement/configurations/me",
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "visitorConfiguration",
          "current",
          config,
        );
        return { dataHandles: [handle] };
      },
    },

    createDropInInvitation: {
      description:
        "Create a walk-in visitor + DropIn invitation in a single call. Mirrors the kiosk's `visitorsKioskCreateDropin` flow: creates the visitor record, then POSTs an invitation tied to the host. Appspace's configured Notifications fan out from there.",
      arguments: z.object({
        firstName: z.string(),
        lastName: z.string(),
        email: z.string(),
        company: z.string().optional(),
        notes: z.string().optional(),
        hostUserId: z.string().describe(
          "Appspace user UUID who hosts the drop-in (receives notification)",
        ),
        hostEmail: z.string().describe("Same user's email"),
        resourceId: z.string().optional().describe(
          "Optional reservation resource UUID (routes to that resource's Concierges)",
        ),
        durationMinutes: z.number().default(15).describe(
          "Length of the drop-in invitation in minutes",
        ),
        visitorType: z.string().default("Guest"),
        purpose: z.string().default("Visiting"),
        timezone: z.string().default("UTC").describe(
          "IANA timezone for the invitation (e.g. 'America/New_York'). Default 'UTC'.",
        ),
      }),
      execute: async (args, context) => {
        // Step 1: Create the visitor (or recover existing on 409)
        let visitor: Record<string, unknown>;
        try {
          visitor = await appspaceApi(
            "/api/v3/visitormanagement/visitors",
            context.globalArgs,
            {
              method: "POST",
              body: {
                firstName: args.firstName,
                lastName: args.lastName,
                email: args.email,
                visitorType: args.visitorType,
                customFields: [],
              },
            },
          ) as Record<string, unknown>;
        } catch (e) {
          const msg = (e as Error).message;
          if (!msg.includes("409")) throw e;
          // Visitor with that email already exists — fall through with a minimal stub.
          context.logger.info(
            "Visitor {email} already exists; using minimal stub for invitation",
            { email: args.email },
          );
          visitor = {
            firstName: args.firstName,
            lastName: args.lastName,
            email: args.email,
          };
        }

        // Step 2: Create the DropIn invitation
        const fullName = `${args.firstName} ${args.lastName}`.trim();
        const titleSuffix = args.company ? ` — ${args.company}` : "";
        const noteParts: string[] = [];
        if (args.notes) noteParts.push(args.notes);
        noteParts.push("Submitted as walk-in.");
        noteParts.push(`Visitor email: ${args.email}`);
        if (args.company) noteParts.push(`Company: ${args.company}`);

        const startAt = new Date();
        startAt.setSeconds(0, 0);
        const endAt = new Date(
          startAt.getTime() + args.durationMinutes * 60 * 1000,
        );

        const inviteBody = {
          type: "DropIn",
          title: `Walk-in: ${fullName}${titleSuffix}`,
          notes: noteParts.join("\n"),
          purpose: args.purpose,
          hosts: [{ userId: args.hostUserId, email: args.hostEmail }],
          resourceIds: args.resourceId ? [args.resourceId] : [],
          visitors: [visitor],
          startAt: startAt.toISOString(),
          endAt: endAt.toISOString(),
          startTimeZone: args.timezone,
          endTimeZone: args.timezone,
          isAllDay: false,
        };

        const invite = await appspaceApi(
          "/api/v3/visitormanagement/invitations",
          context.globalArgs,
          { method: "POST", body: inviteBody },
        ) as Record<string, unknown>;

        context.logger.info(
          "Created DropIn invitation for {email}, host {host}",
          { email: args.email, host: args.hostEmail },
        );

        const visitorHandle = await context.writeResource(
          "visitor",
          sanitizeId(args.email),
          visitor,
        );
        const inviteHandle = await context.writeResource(
          "invitation",
          sanitizeId(`${args.email}-dropin`),
          invite,
        );
        return { dataHandles: [visitorHandle, inviteHandle] };
      },
    },

    listEvents: {
      description:
        "Query visitor events (the runtime instances of invitations — when visitors are actually checking in/out).",
      arguments: z.object({
        startAt: z.string().optional(),
        endAt: z.string().optional(),
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const params: Record<string, string> = {};
        if (args.startAt) params.startAt = args.startAt;
        if (args.endAt) params.endAt = args.endAt;

        const events = await appspacePaged(
          "/api/v3/visitormanagement/events",
          context.globalArgs,
          { params, maxItems: args.maxItems },
        );
        const handles = [];
        for (const e of events) {
          const handle = await context.writeResource(
            "invitation",
            sanitizeId((e.id as string) ?? "event"),
            e,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    checkin: {
      description: "Check a visitor in to an event.",
      arguments: z.object({
        eventId: z.string(),
        visitorId: z.string(),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/visitormanagement/events/${
            encodeURIComponent(args.eventId)
          }/visitors/${encodeURIComponent(args.visitorId)}/checkin`,
          context.globalArgs,
          { method: "POST" },
        );
        return {
          data: {
            attributes: { ...args, result },
            name: `checkin-${sanitizeId(args.visitorId)}`,
          },
        };
      },
    },

    checkout: {
      description: "Check a visitor out of an event.",
      arguments: z.object({
        eventId: z.string(),
        visitorId: z.string(),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/visitormanagement/events/${
            encodeURIComponent(args.eventId)
          }/visitors/${encodeURIComponent(args.visitorId)}/checkout`,
          context.globalArgs,
          { method: "POST" },
        );
        return {
          data: {
            attributes: { ...args, result },
            name: `checkout-${sanitizeId(args.visitorId)}`,
          },
        };
      },
    },
  },
};
