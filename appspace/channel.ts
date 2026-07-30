import { z } from "npm:zod@4.3.6";
import {
  appspaceApi,
  AppspaceGlobalArgsSchema,
  appspacePaged,
  sanitizeId,
} from "./_client.ts";

const ChannelSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  caption: z.string().optional(),
  type: z.number().optional(),
  accountId: z.string().optional(),
  networkId: z.string().optional(),
  networkName: z.string().optional(),
  permission: z.string().optional(),
  privacyType: z.union([z.string(), z.number()]).optional(),
  contentCount: z.number().optional(),
  contentLastPublishedAt: z.string().optional(),
  contentLastUpdatedAt: z.string().optional(),
  subscriptionMode: z.string().optional(),
  membershipMode: z.string().optional(),
  publishingRule: z.number().optional(),
  channelGroups: z.array(z.record(z.string(), z.unknown())).optional(),
  publishTo: z.array(z.record(z.string(), z.unknown())).optional(),
  inheritedPublishTo: z.array(z.record(z.string(), z.unknown())).optional(),
  metadata: z.array(z.record(z.string(), z.unknown())).optional(),
  libraryIds: z.array(z.string()).optional(),
  thumbnailResourceId: z.string().optional(),
}).passthrough();

const ChannelGroupSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  description: z.string().optional(),
  networkId: z.string().optional(),
  networkName: z.string().optional(),
}).passthrough();

const PlaylistItemSchema = z.object({
  id: z.string(),
  channelId: z.string().optional(),
  name: z.string().optional(),
  type: z.string().optional(),
  position: z.number().optional(),
  disabled: z.boolean().optional(),
  contentId: z.string().optional(),
  contentURL: z.string().optional(),
  articleUrl: z.string().optional(),
  thumbnailURL: z.string().optional(),
  contentFormat: z.string().optional(),
  // Appspace is inconsistent here: contentDuration comes back as a number but
  // contentNaturalDuration as a string on the same item. Accept both on each.
  contentDuration: z.union([z.number(), z.string()]).optional(),
  contentNaturalDuration: z.union([z.number(), z.string()]).optional(),
  contentTemplateId: z.string().optional(),
  contentTemplateType: z.string().optional(),
  contentTags: z.array(z.unknown()).optional(),
  contentMetadata: z.array(z.record(z.string(), z.unknown())).optional(),
  sourceId: z.string().optional(),
  sourceName: z.string().optional(),
  sourceType: z.union([z.string(), z.number()]).optional(),
  playoutSchedule: z.unknown().optional(),
  filter: z.unknown().optional(),
}).passthrough();

const PlaylistSourceSchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.union([z.string(), z.number()]).optional(),
}).passthrough();

const PublishTargetSchema = z.object({
  id: z.string().optional(),
  targetId: z.string(),
  targetType: z.number(),
  createdAt: z.string().optional(),
  createdBy: z.string().optional(),
}).passthrough();

const EpgEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
}).passthrough();

/** Publish-target discriminator observed on this tenant. */
const TARGET_TYPE_DEVICE = 7;
const TARGET_TYPE_DEVICE_GROUP = 8;

/**
 * Build a collision-proof resource instance name.
 *
 * Appspace names are unique nowhere: a tenant can hold two channels both
 * called "test", and a single playlist routinely contains several slides
 * literally named "2", "4" and "8". Swamp rejects duplicate data instance
 * names outright, so every name here carries a short id suffix and keeps the
 * human label only for readability.
 */
function instanceName(
  label: unknown,
  id: unknown,
  prefix?: string,
): string {
  const text = typeof label === "string" && label.trim()
    ? label.trim()
    : "item";
  const uid = String(id ?? "").replace(/-/g, "").slice(0, 8);
  return sanitizeId([prefix, text, uid].filter(Boolean).join("-"));
}

/**
 * Appspace channel, playlist and live-channel reads for a tenant.
 *
 * Covers the three v3 services that together describe *what a device is
 * supposed to play*: channeldirectory (the channels themselves, their groups
 * and their publish targets), channelplaylist (the ordered content items and
 * dynamic sources inside a channel) and livechannel (EPG entries).
 *
 * Everything here is read-only except publishToDevice, which defaults to
 * preview mode and never writes unless explicitly told to. Assignment is a
 * read-modify-write against a full-replace endpoint, so it always merges with
 * the existing targets rather than replacing them.
 *
 * Channel `type` observed on this tenant: 1 = playlist channel, 2 = live
 * channel, 3 = dynamic/advanced. Publish `targetType`: 7 = device,
 * 8 = device group.
 */
export const model = {
  type: "@dougschaefer/appspace-channel",
  version: "2026.07.30.1",
  globalArguments: AppspaceGlobalArgsSchema,
  resources: {
    channel: {
      description:
        "Appspace channel — name, type, content counts, publish targets and metadata",
      schema: ChannelSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    channelGroup: {
      description: "Channel group used to organise channels within a network",
      schema: ChannelGroupSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    playlistItem: {
      description:
        "One content item in a channel playlist — image, video or card, with duration, format and playout schedule",
      schema: PlaylistItemSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    playlistSource: {
      description:
        "Dynamic source feeding a channel playlist (library folder, feed, etc.)",
      schema: PlaylistSourceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    publishTarget: {
      description:
        "Publish target binding a channel to a device (targetType 7) or device group (targetType 8)",
      schema: PublishTargetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    epgEntry: {
      description: "Live-channel EPG entry",
      schema: EpgEntrySchema,
      lifetime: "1d",
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description:
        "List channels in the tenant. Returns every channel by default; pass maxItems to cap.",
      arguments: z.object({
        maxItems: z.number().optional().default(500).describe(
          "Maximum channels to return",
        ),
      }),
      execute: async (args, context) => {
        const channels = await appspacePaged(
          "/api/v3/channeldirectory",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        context.logger.info("Found {count} channels", {
          count: channels.length,
        });
        const handles = [];
        for (const c of channels) {
          const name = instanceName(c.name, c.id);
          handles.push(await context.writeResource("channel", name, c));
        }
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Get a single channel by ID.",
      arguments: z.object({
        id: z.string().describe("Channel UUID"),
      }),
      execute: async (args, context) => {
        const channel = await appspaceApi(
          `/api/v3/channeldirectory/${encodeURIComponent(args.id)}`,
          context.globalArgs,
        ) as Record<string, unknown>;
        const name = instanceName(channel.name, channel.id ?? args.id);
        const handle = await context.writeResource("channel", name, channel);
        return { dataHandles: [handle] };
      },
    },

    findByName: {
      description:
        "Find channels by name. The directory endpoint has no name filter, so this pages and matches client-side.",
      arguments: z.object({
        name: z.string().describe("Channel name to match (case-insensitive)"),
        exact: z.boolean().default(false).describe(
          "When true, match the whole name; when false, substring match.",
        ),
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const target = args.name.toLowerCase();
        const channels = await appspacePaged(
          "/api/v3/channeldirectory",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        const matches = channels.filter((c) => {
          const n = String(c.name ?? "").toLowerCase();
          return args.exact ? n === target : n.includes(target);
        });
        context.logger.info("Matched {n} of {total} channels for {name}", {
          n: matches.length,
          total: channels.length,
          name: args.name,
        });
        const handles = [];
        for (const c of matches) {
          const name = instanceName(c.name, c.id);
          handles.push(await context.writeResource("channel", name, c));
        }
        return { dataHandles: handles };
      },
    },

    listGroups: {
      description: "List channel groups in the tenant.",
      arguments: z.object({
        maxItems: z.number().optional().default(200),
      }),
      execute: async (args, context) => {
        const groups = await appspacePaged(
          "/api/v3/channeldirectory/groups",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        const handles = [];
        for (const g of groups) {
          const name = instanceName(g.name, g.id);
          handles.push(await context.writeResource("channelGroup", name, g));
        }
        return { dataHandles: handles };
      },
    },

    listPlaylistItems: {
      description:
        "List the ordered content items in a channel's playlist — the authoritative answer to what a device assigned this channel will play. Each item carries type (Image/Video/Card), contentFormat (e.g. 'h264 (Main)'), duration and content URLs.",
      arguments: z.object({
        channelId: z.string().describe("Channel UUID"),
        maxItems: z.number().optional().default(500),
      }),
      execute: async (args, context) => {
        const items = await appspacePaged(
          `/api/v3/channelplaylist/${encodeURIComponent(args.channelId)}/items`,
          context.globalArgs,
          { maxItems: args.maxItems },
        );

        const byType: Record<string, number> = {};
        for (const i of items) {
          const t = String(i.type ?? "Unknown");
          byType[t] = (byType[t] ?? 0) + 1;
        }
        context.logger.info(
          "Playlist {channelId} has {count} items ({breakdown})",
          {
            channelId: args.channelId,
            count: items.length,
            breakdown: Object.entries(byType).map(([k, v]) => `${k}=${v}`)
              .join(", "),
          },
        );

        // Playlist item names are NOT unique — real channels contain several
        // slides literally named "2", "4", "8", and the same content can appear
        // in more than one zone. Key on the item id (a UUID) so instance names
        // can't collide, keeping the label only for readability.
        const handles = [];
        for (const i of items) {
          const name = instanceName(
            i.name ?? i.contentId,
            i.id,
            args.channelId.slice(0, 8),
          );
          handles.push(await context.writeResource("playlistItem", name, i));
        }
        return { dataHandles: handles };
      },
    },

    listPlaylistSources: {
      description:
        "List the dynamic sources feeding a channel playlist (library folders, feeds). Static playlists return an empty list.",
      arguments: z.object({
        channelId: z.string().describe("Channel UUID"),
      }),
      execute: async (args, context) => {
        const resp = await appspaceApi(
          `/api/v3/channelplaylist/${
            encodeURIComponent(args.channelId)
          }/sources`,
          context.globalArgs,
        ) as { items?: Array<Record<string, unknown>> } | null;
        const sources = resp?.items ?? [];
        const handles = [];
        for (const s of sources) {
          const name = instanceName(s.name, s.id, args.channelId.slice(0, 8));
          handles.push(await context.writeResource("playlistSource", name, s));
        }
        return { dataHandles: handles };
      },
    },

    getPublishTo: {
      description:
        "List the publish targets for a channel — which devices (targetType 7) and device groups (targetType 8) receive it.",
      arguments: z.object({
        channelId: z.string().describe("Channel UUID"),
      }),
      execute: async (args, context) => {
        const resp = await appspaceApi(
          `/api/v3/channeldirectory/${
            encodeURIComponent(args.channelId)
          }/publishto`,
          context.globalArgs,
        ) as
          | { items?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>
          | null;
        const targets = Array.isArray(resp) ? resp : (resp?.items ?? []);
        context.logger.info("Channel {channelId} publishes to {n} target(s)", {
          channelId: args.channelId,
          n: targets.length,
        });
        const handles = [];
        for (const t of targets) {
          const name = instanceName(
            t.targetId,
            t.id ?? t.targetId,
            args.channelId.slice(0, 8),
          );
          handles.push(await context.writeResource("publishTarget", name, t));
        }
        return { dataHandles: handles };
      },
    },

    listLiveEpg: {
      description: "List live-channel EPG entries for the tenant.",
      arguments: z.object({
        maxItems: z.number().optional().default(200),
      }),
      execute: async (args, context) => {
        const entries = await appspacePaged(
          "/api/v3/livechannel/epg",
          context.globalArgs,
          { maxItems: args.maxItems },
        );
        const handles = [];
        for (const e of entries) {
          const name = instanceName(e.name, e.id);
          handles.push(await context.writeResource("epgEntry", name, e));
        }
        return { dataHandles: handles };
      },
    },

    setPublishTargets: {
      description:
        "Replace a channel's publish targets with an explicit list. PREVIEW BY DEFAULT. Use this when you need exact control — publishToDevice is the safer everyday path. NOTE: the endpoint is a FULL REPLACE regardless of publishingRule, so whatever you pass here becomes the complete target set.",
      arguments: z.object({
        channelId: z.string().describe("Channel UUID"),
        targets: z.array(z.object({
          targetId: z.string(),
          targetType: z.enum(["Device", "DeviceGroup"]),
          name: z.string().optional(),
        })).describe("The COMPLETE desired target set"),
        preview: z.boolean().default(true).describe(
          "When true (default) log the intended set and write nothing.",
        ),
      }),
      execute: async (args, context) => {
        const path = `/api/v3/channeldirectory/${
          encodeURIComponent(args.channelId)
        }/publishto`;
        const current = await appspaceApi(path, context.globalArgs) as
          | { items?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>
          | null;
        const existing = Array.isArray(current)
          ? current
          : (current?.items ?? []);

        if (args.preview) {
          context.logger.info(
            "PREVIEW — would set channel {channelId} targets from {before} to {after}. Re-run with preview=false to apply.",
            {
              channelId: args.channelId,
              before: existing.length,
              after: args.targets.length,
            },
          );
          return { dataHandles: [] };
        }

        await appspaceApi(path, context.globalArgs, {
          method: "PUT",
          body: {
            publishingRule: "Append",
            publishTo: args.targets.map((t) => ({
              publishToId: t.targetId,
              targetId: t.targetId,
              targetType: t.targetType,
              ...(t.name ? { name: t.name } : {}),
            })),
          },
        });

        const after = await appspaceApi(path, context.globalArgs) as
          | { items?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>
          | null;
        const verified = Array.isArray(after) ? after : (after?.items ?? []);
        context.logger.info(
          "Channel {channelId} targets: {before} -> {after}",
          {
            channelId: args.channelId,
            before: existing.length,
            after: verified.length,
          },
        );
        const handles = [];
        for (const t of verified) {
          handles.push(
            await context.writeResource(
              "publishTarget",
              instanceName(
                t.targetId,
                t.id ?? t.targetId,
                args.channelId.slice(0, 8),
              ),
              t,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    publishToDevice: {
      description:
        "Publish a channel to a device or device group. PREVIEW BY DEFAULT — set preview=false to actually write. WARNING: the underlying endpoint is a FULL REPLACE and ignores publishingRule 'Append', so this reads the current targets and resends them alongside the new one.",
      arguments: z.object({
        channelId: z.string().describe("Channel UUID to publish"),
        targetId: z.string().describe("Device UUID, or device group UUID"),
        targetType: z.enum(["Device", "DeviceGroup"]).default("Device")
          .describe("Whether targetId names a device or a device group"),
        name: z.string().optional().describe(
          "Optional friendly label stored alongside the target",
        ),
        publishingRule: z.enum(["Append", "Overwrite"]).default("Append")
          .describe(
            "Append adds to existing targets; Overwrite REPLACES every existing target on the channel.",
          ),
        preview: z.boolean().default(true).describe(
          "When true (default) log what would be written and write nothing.",
        ),
      }),
      execute: async (args, context) => {
        const path = `/api/v3/channeldirectory/${
          encodeURIComponent(args.channelId)
        }/publishto`;

        const current = await appspaceApi(path, context.globalArgs) as
          | { items?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>
          | null;
        const existing = Array.isArray(current)
          ? current
          : (current?.items ?? []);

        const numericType = args.targetType === "Device"
          ? TARGET_TYPE_DEVICE
          : TARGET_TYPE_DEVICE_GROUP;
        const already = existing.some((t) =>
          t.targetId === args.targetId && t.targetType === numericType
        );
        if (already) {
          context.logger.info(
            "Channel {channelId} already publishes to {targetId}; nothing to do",
            { channelId: args.channelId, targetId: args.targetId },
          );
          const handles = [];
          for (const t of existing) {
            handles.push(
              await context.writeResource(
                "publishTarget",
                instanceName(
                  t.targetId,
                  t.id ?? t.targetId,
                  args.channelId.slice(0, 8),
                ),
                t,
              ),
            );
          }
          return { dataHandles: handles };
        }

        // The PUT body is an object, not an array: { publishingRule, publishTo }.
        // publishingRule is the STRING enum Append|Overwrite even though GET
        // returns it numerically, and targetType is the STRING enum member even
        // though GET returns its 1-based ordinal (7 = Device, 8 = DeviceGroup).
        // VERIFIED THE HARD WAY 2026-07-29: this endpoint is a FULL REPLACE and
        // publishingRule:"Append" does NOT append — sending only the new target
        // dropped a live channel from 3 targets to 1 and cut real displays off
        // the channel. Always resend the existing targets alongside the new one.
        const numericToName = (t: unknown) =>
          t === TARGET_TYPE_DEVICE_GROUP ? "DeviceGroup" : "Device";
        const body = {
          publishingRule: args.publishingRule,
          publishTo: [
            ...existing.map((t) => ({
              publishToId: t.targetId as string,
              targetId: t.targetId as string,
              targetType: numericToName(t.targetType),
              ...(typeof t.name === "string" && t.name ? { name: t.name } : {}),
            })),
            {
              publishToId: args.targetId,
              targetId: args.targetId,
              targetType: args.targetType,
              ...(args.name ? { name: args.name } : {}),
            },
          ],
        };

        if (args.preview) {
          context.logger.info(
            "PREVIEW — would {rule} {targetType} {targetId} on channel {channelId} (currently {before} target(s)). Re-run with preview=false to apply.",
            {
              rule: args.publishingRule.toLowerCase(),
              targetType: args.targetType,
              targetId: args.targetId,
              channelId: args.channelId,
              before: existing.length,
            },
          );
          return { dataHandles: [] };
        }

        if (args.publishingRule === "Overwrite") {
          context.logger.warning(
            "Overwrite REPLACES all {before} existing target(s) on channel {channelId}",
            { before: existing.length, channelId: args.channelId },
          );
        }

        await appspaceApi(path, context.globalArgs, {
          method: "PUT",
          body,
        });

        const after = await appspaceApi(path, context.globalArgs) as
          | { items?: Array<Record<string, unknown>> }
          | Array<Record<string, unknown>>
          | null;
        const verified = Array.isArray(after) ? after : (after?.items ?? []);
        context.logger.info(
          "Published channel {channelId} to {targetId}; targets went {before} -> {after}",
          {
            channelId: args.channelId,
            targetId: args.targetId,
            before: existing.length,
            after: verified.length,
          },
        );

        const handles = [];
        for (const t of verified) {
          handles.push(
            await context.writeResource(
              "publishTarget",
              instanceName(
                t.targetId,
                t.id ?? t.targetId,
                args.channelId.slice(0, 8),
              ),
              t,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
  },
};
