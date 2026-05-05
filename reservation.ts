import { z } from "npm:zod@4.3.6";
import {
  appspaceApi,
  AppspaceGlobalArgsSchema,
  appspacePaged,
  sanitizeId,
} from "./_client.ts";

const ResourceRefSchema = z.object({
  resourceId: z.string(),
  resourceName: z.string().optional(),
  resourceType: z.string().optional(),
  resourceSubType: z.string().optional(),
  resourceNetworkId: z.string().optional(),
}).passthrough();

const EventSchema = z.object({
  id: z.string(),
  reservationId: z.string().optional(),
  resourceId: z.string().optional(),
  resources: z.array(ResourceRefSchema).optional(),
  provider: z.record(z.string(), z.unknown()).optional(),
  origin: z.string().optional(),
}).passthrough();

const ReservationSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  notes: z.string().optional(),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  status: z.string().optional(),
  isRecurring: z.boolean().optional(),
  isAllDay: z.boolean().optional(),
  organizer: z.record(z.string(), z.unknown()).optional(),
  resources: z.array(ResourceRefSchema).optional(),
  events: z.array(z.unknown()).optional(),
  attendees: z.array(z.unknown()).optional(),
}).passthrough();

const ReservableResourceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  subType: z.string().optional(),
  networkId: z.string().optional(),
  networkName: z.string().optional(),
  capacity: z.number().optional(),
  isReservable: z.boolean().optional(),
  reservableStatus: z.string().optional(),
}).passthrough();

/**
 * `@dougschaefer/appspace-reservation` model — room and desk reservations on
 * Appspace Cloud. Covers reservable resources, event lifecycle (list, get,
 * cancel, end, extend, release, checkin), reservation CRUD, host
 * availability lookups, and per-resource schedule pulls. The reservable-
 * resource shape uses `id`/`name`/`type` at the top level (not the
 * `resourceId`/`resourceName`/`resourceType` triple — that variant only
 * shows up nested inside event resource references).
 */
export const model = {
  type: "@dougschaefer/appspace-reservation",
  version: "2026.04.27.1",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    event: {
      description:
        "Reservation event — a scheduled instance bound to one or more resources, possibly synced from an external calendar provider",
      schema: EventSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    reservation: {
      description:
        "Reservation record — the booking abstraction that owns one or more events and tracks attendees, checkpoints, and resources",
      schema: ReservationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    reservableResource: {
      description: "Resource (room, desk, equipment) that can be reserved",
      schema: ReservableResourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    listEvents: {
      description:
        "List reservation events with optional date and resource filtering. Pages automatically.",
      arguments: z.object({
        startAt: z.string().optional().describe(
          "ISO 8601 — return events at or after this time",
        ),
        endAt: z.string().optional().describe(
          "ISO 8601 — return events at or before this time",
        ),
        resourceId: z.string().optional().describe(
          "Filter by resource ID (room, desk, etc.)",
        ),
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const params: Record<string, string | number> = {};
        if (args.startAt) params.startAt = args.startAt;
        if (args.endAt) params.endAt = args.endAt;
        if (args.resourceId) params.resourceId = args.resourceId;

        const events = await appspacePaged(
          "/api/v3/reservation/events",
          context.globalArgs,
          { params, maxItems: args.maxItems },
        );
        context.logger.info("Found {count} events", { count: events.length });

        const handles = [];
        for (const e of events) {
          const handle = await context.writeResource(
            "event",
            sanitizeId(e.id as string),
            e,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getEvent: {
      description: "Get details for a specific event.",
      arguments: z.object({
        eventId: z.string(),
      }),
      execute: async (args, context) => {
        const event = await appspaceApi(
          `/api/v3/reservation/events/${encodeURIComponent(args.eventId)}`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "event",
          sanitizeId(args.eventId),
          event,
        );
        return { dataHandles: [handle] };
      },
    },

    cancelEvent: {
      description: "Cancel an event.",
      arguments: z.object({
        eventId: z.string(),
        reason: z.string().optional(),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/reservation/events/${
            encodeURIComponent(args.eventId)
          }/cancel`,
          context.globalArgs,
          { method: "POST", body: { reason: args.reason ?? "" } },
        );
        context.logger.info("Cancelled event {id}", { id: args.eventId });
        return {
          data: {
            attributes: { eventId: args.eventId, result },
            name: `cancel-${sanitizeId(args.eventId)}`,
          },
        };
      },
    },

    endEvent: {
      description:
        "End an event early (releases the resource for the remaining duration).",
      arguments: z.object({ eventId: z.string() }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/reservation/events/${encodeURIComponent(args.eventId)}/end`,
          context.globalArgs,
          { method: "POST" },
        );
        return {
          data: {
            attributes: { eventId: args.eventId, result },
            name: `end-${sanitizeId(args.eventId)}`,
          },
        };
      },
    },

    extendEvent: {
      description: "Extend an event's end time.",
      arguments: z.object({
        eventId: z.string(),
        endAt: z.string().describe("New end time (ISO 8601)"),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/reservation/events/${
            encodeURIComponent(args.eventId)
          }/extend`,
          context.globalArgs,
          { method: "POST", body: { endAt: args.endAt } },
        );
        return {
          data: {
            attributes: { eventId: args.eventId, endAt: args.endAt, result },
            name: `extend-${sanitizeId(args.eventId)}`,
          },
        };
      },
    },

    releaseEvent: {
      description: "Release resources from an event without cancelling it.",
      arguments: z.object({ eventId: z.string() }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/reservation/events/${
            encodeURIComponent(args.eventId)
          }/release`,
          context.globalArgs,
          { method: "POST" },
        );
        return {
          data: {
            attributes: { eventId: args.eventId, result },
            name: `release-${sanitizeId(args.eventId)}`,
          },
        };
      },
    },

    checkinEvent: {
      description: "Check in to an event (confirm occupancy).",
      arguments: z.object({ eventId: z.string() }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/reservation/events/${
            encodeURIComponent(args.eventId)
          }/checkin`,
          context.globalArgs,
          { method: "POST" },
        );
        return {
          data: {
            attributes: { eventId: args.eventId, result },
            name: `checkin-${sanitizeId(args.eventId)}`,
          },
        };
      },
    },

    listReservations: {
      description:
        "Query reservations with optional filtering. Pages automatically.",
      arguments: z.object({
        startAt: z.string().optional(),
        endAt: z.string().optional(),
        resourceId: z.string().optional(),
        organizer: z.string().optional().describe("Filter by organizer email"),
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const params: Record<string, string | number> = {};
        if (args.startAt) params.startAt = args.startAt;
        if (args.endAt) params.endAt = args.endAt;
        if (args.resourceId) params.resourceId = args.resourceId;
        if (args.organizer) params.organizer = args.organizer;

        const reservations = await appspacePaged(
          "/api/v3/reservation/reservations",
          context.globalArgs,
          { params, maxItems: args.maxItems },
        );
        context.logger.info("Found {count} reservations", {
          count: reservations.length,
        });

        const handles = [];
        for (const r of reservations) {
          const handle = await context.writeResource(
            "reservation",
            sanitizeId(r.id as string),
            r,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getReservation: {
      description: "Get details for a specific reservation.",
      arguments: z.object({ reservationId: z.string() }),
      execute: async (args, context) => {
        const r = await appspaceApi(
          `/api/v3/reservation/reservations/${
            encodeURIComponent(args.reservationId)
          }`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const handle = await context.writeResource(
          "reservation",
          sanitizeId(args.reservationId),
          r,
        );
        return { dataHandles: [handle] };
      },
    },

    createReservation: {
      description: "Create a new reservation.",
      arguments: z.object({
        title: z.string().describe("Reservation title"),
        startAt: z.string().describe("Start time (ISO 8601)"),
        endAt: z.string().describe("End time (ISO 8601)"),
        resourceIds: z.array(z.string()).describe(
          "Reservable resource IDs (rooms, desks, etc.)",
        ),
        organizerEmail: z.string().optional().describe(
          "Organizer email (defaults to token user)",
        ),
        attendees: z.array(z.string()).optional().describe(
          "Attendee emails",
        ),
        notes: z.string().optional(),
        isAllDay: z.boolean().optional(),
      }),
      execute: async (args, context) => {
        const body: Record<string, unknown> = {
          title: args.title,
          startAt: args.startAt,
          endAt: args.endAt,
          resources: args.resourceIds.map((id) => ({ resourceId: id })),
          notes: args.notes ?? "",
          isAllDay: args.isAllDay ?? false,
        };
        if (args.organizerEmail) {
          body.organizer = { username: args.organizerEmail };
        }
        if (args.attendees) {
          body.attendees = args.attendees.map((email) => ({
            username: email,
          }));
        }

        const result = await appspaceApi(
          "/api/v3/reservation/reservations",
          context.globalArgs,
          { method: "POST", body },
        ) as Record<string, unknown>;

        const id = (result.id as string) ?? "new";
        context.logger.info("Created reservation {id}: {title}", {
          id,
          title: args.title,
        });
        const handle = await context.writeResource(
          "reservation",
          sanitizeId(id),
          result,
        );
        return { dataHandles: [handle] };
      },
    },

    updateReservation: {
      description: "Update one or more properties of an existing reservation.",
      arguments: z.object({
        reservationId: z.string(),
        title: z.string().optional(),
        startAt: z.string().optional(),
        endAt: z.string().optional(),
        notes: z.string().optional(),
      }),
      execute: async (args, context) => {
        const { reservationId, ...patch } = args;
        const body: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(patch)) {
          if (v !== undefined) body[k] = v;
        }

        const result = await appspaceApi(
          `/api/v3/reservation/reservations/${
            encodeURIComponent(reservationId)
          }`,
          context.globalArgs,
          { method: "PATCH", body },
        );
        return {
          data: {
            attributes: { reservationId, patch: body, result },
            name: `update-${sanitizeId(reservationId)}`,
          },
        };
      },
    },

    deleteReservation: {
      description: "Delete a reservation.",
      arguments: z.object({ reservationId: z.string() }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          `/api/v3/reservation/reservations/${
            encodeURIComponent(args.reservationId)
          }`,
          context.globalArgs,
          { method: "DELETE" },
        );
        context.logger.info("Deleted reservation {id}", {
          id: args.reservationId,
        });
        return {
          data: {
            attributes: { reservationId: args.reservationId, result },
            name: `delete-${sanitizeId(args.reservationId)}`,
          },
        };
      },
    },

    listReservableResources: {
      description:
        "List resources (rooms, desks, equipment) that can be reserved.",
      arguments: z.object({
        resourceType: z.string().optional().describe(
          "Filter by type (e.g., 'Room', 'Desk')",
        ),
        buildingId: z.string().optional(),
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const params: Record<string, string | number> = {};
        if (args.resourceType) params.resourceType = args.resourceType;
        if (args.buildingId) params.buildingId = args.buildingId;

        const resources = await appspacePaged(
          "/api/v3/reservation/resources/reservable",
          context.globalArgs,
          { params, maxItems: args.maxItems },
        );
        context.logger.info("Found {count} reservable resources", {
          count: resources.length,
        });

        const handles = [];
        for (const r of resources) {
          const name = sanitizeId(
            (r.name as string) ?? (r.id as string) ?? "resource",
          );
          const handle = await context.writeResource(
            "reservableResource",
            name,
            r,
          );
          handles.push(handle);
        }
        return { dataHandles: handles };
      },
    },

    getMyEvents: {
      description:
        "Get events related to the current user (the Service Account behind the token).",
      arguments: z.object({
        startAt: z.string().optional(),
        endAt: z.string().optional(),
      }),
      execute: async (args, context) => {
        const params: Record<string, string> = {};
        if (args.startAt) params.startAt = args.startAt;
        if (args.endAt) params.endAt = args.endAt;

        const events = await appspaceApi(
          "/api/v3/reservation/users/me/events",
          context.globalArgs,
          { params },
        );
        return {
          data: {
            attributes: { events },
            name: "my-events",
          },
        };
      },
    },

    checkUserAvailability: {
      description:
        "Check whether one or more users are available during a given time window.",
      arguments: z.object({
        attendees: z.array(z.string()).describe("List of attendee emails"),
        startAt: z.string().describe("Start time (ISO 8601)"),
        endAt: z.string().describe("End time (ISO 8601)"),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          "/api/v3/reservation/useravailabilities",
          context.globalArgs,
          {
            method: "POST",
            body: {
              attendees: args.attendees,
              startAt: args.startAt,
              endAt: args.endAt,
            },
          },
        );
        return {
          data: {
            attributes: { ...args, result },
            name: "user-availability",
          },
        };
      },
    },

    getSchedule: {
      description:
        "Get a schedule view across resources for a given time window.",
      arguments: z.object({
        resourceIds: z.array(z.string()).describe("Resources to include"),
        startAt: z.string(),
        endAt: z.string(),
      }),
      execute: async (args, context) => {
        const result = await appspaceApi(
          "/api/v3/reservation/schedules",
          context.globalArgs,
          {
            method: "POST",
            body: {
              resourceIds: args.resourceIds,
              startAt: args.startAt,
              endAt: args.endAt,
            },
          },
        );
        return {
          data: {
            attributes: { ...args, schedule: result },
            name: "schedule",
          },
        };
      },
    },
  },
};
