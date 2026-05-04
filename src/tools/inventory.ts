// Parts/inventory tools: catalog (parts), storage devices (warehouses/
// vehicles), and stocktakes. Filter columns verified live against
// goldmanplumbingservices.simprosuite.com:
//   catalogs:   ?Name=%X% , ?PartNo=%X%
//   storageDevices: ?Name=%X%
//   stockTakes: filtered by storage device

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ENDPOINTS } from "../simpro/endpoints.js";
import { paginationQuery } from "../utils/pagination.js";
import { buildKeywordFilter } from "../utils/filter.js";
import { idSchema, rawFlagSchema } from "../utils/schemas.js";
import { extractList, formatList, formatRecord, safeRun, ToolCtx } from "./_shared.js";

interface SimproCatalog {
  ID?: number;
  PartNo?: string;
  Name?: string;
  TradePrice?: number;
  TradePriceEx?: number;
  TradePriceInc?: number;
  Markup?: number;
  SellPrice?: number;
  IsInventory?: boolean;
  IsAsset?: boolean;
  Manufacturer?: string;
  StorageLocation?: string;
  UOM?: { ID?: number; Name?: string } | null;
  Group?: { ID?: number; Name?: string };
  [key: string]: unknown;
}

interface SimproStorageDevice {
  ID?: number;
  Name?: string;
  [key: string]: unknown;
}

interface SimproStockTake {
  ID?: number;
  StorageDevice?: { ID?: number; Name?: string };
  Approved?: boolean;
  Value?: number;
  [key: string]: unknown;
}

export function registerInventoryTools(server: McpServer, ctx: ToolCtx) {
  // ---- search catalog (parts) ----
  server.tool(
    "simpro_search_catalog",
    "Search the Simpro parts catalog. Use `partNo` for an exact part-number substring match (e.g. 'BVA083'), or `query` for a free-text search of the part Name (e.g. 'gas valve'). Returns part ID, code, name, and prices. Goldman Plumbing's catalog has hundreds of thousands of items — always pass at least one filter.",
    {
      query: z.string().optional()
        .describe("Free-text search against the part's Name."),
      partNo: z.string().optional()
        .describe("Substring match on PartNo (the part code/SKU)."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ query, partNo, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.catalogs);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          ...buildKeywordFilter(query, "Name"),
          ...buildKeywordFilter(partNo, "PartNo"),
        });
        const items = extractList(resp) as SimproCatalog[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (c) =>
            `#${c.ID ?? "?"} ${c.PartNo ?? "(no part no)"} — ${c.Name ?? "(unnamed)"}` +
            `${c.TradePriceInc !== undefined && c.TradePriceInc !== 0 ? ` | trade: $${c.TradePriceInc}` : ""}` +
            `${c.SellPrice !== undefined && c.SellPrice !== 0 ? ` | sell: $${c.SellPrice}` : ""}` +
            `${c.IsInventory ? " [inventory]" : ""}` +
            `${c.IsAsset ? " [asset]" : ""}`,
          resp, raw === true,
        );
      }),
  );

  // ---- get catalog item ----
  server.tool(
    "simpro_get_catalog_item",
    "Get full detail for a Simpro catalog/parts item by ID — includes all prices, tax codes, group, UOM, manufacturer, storage location.",
    { catalogId: idSchema, raw: rawFlagSchema },
    async ({ catalogId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.catalogById(catalogId));
        const resp = await ctx.client.get<SimproCatalog>(path);
        return formatRecord(
          `Catalog #${resp.ID ?? catalogId}: ${resp.PartNo ?? ""} ${resp.Name ?? ""}`.trim(),
          resp, resp, raw === true,
        );
      }),
  );

  // ---- search storage devices ----
  server.tool(
    "simpro_search_storage_devices",
    "Search Simpro storage devices (warehouses, trucks, vehicles, vans). Use to find storage IDs needed by other tools.",
    {
      query: z.string().optional().describe("Free-text search against the device Name."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ query, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.storageDevices);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          ...buildKeywordFilter(query, "Name"),
        });
        const items = extractList(resp) as SimproStorageDevice[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (s) => `#${s.ID ?? "?"} ${s.Name ?? "(unnamed)"}`,
          resp, raw === true,
        );
      }),
  );

  // ---- get storage device ----
  server.tool(
    "simpro_get_storage_device",
    "Get full detail of a Simpro storage device (warehouse / vehicle) by ID.",
    { storageDeviceId: idSchema, raw: rawFlagSchema },
    async ({ storageDeviceId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.storageDeviceById(storageDeviceId));
        const resp = await ctx.client.get<SimproStorageDevice>(path);
        return formatRecord(
          `Storage Device #${resp.ID ?? storageDeviceId}: ${resp.Name ?? "(unnamed)"}`,
          resp, resp, raw === true,
        );
      }),
  );

  // ---- search stock takes ----
  server.tool(
    "simpro_search_stock_takes",
    "Search Simpro stocktake history. Optionally filter by storage device.",
    {
      storageDeviceId: idSchema.optional()
        .describe("Filter to stocktakes for a specific warehouse/vehicle."),
      page: z.number().int().min(1).optional(),
      pageSize: z.number().int().min(1).max(1000).optional(),
      raw: rawFlagSchema,
    },
    async ({ storageDeviceId, page, pageSize, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.stockTakes);
        const pg = paginationQuery(ctx.config, page, pageSize);
        const resp = await ctx.client.get<unknown>(path, {
          ...pg.query,
          "StorageDevice.ID": storageDeviceId,
        });
        const items = extractList(resp) as SimproStockTake[];
        return formatList(
          items, undefined, pg.page, pg.pageSize,
          (st) =>
            `#${st.ID ?? "?"}` +
            `${st.StorageDevice?.Name ? ` | device: ${st.StorageDevice.Name}` : ""}` +
            `${st.Value !== undefined ? ` | value: $${st.Value}` : ""}` +
            `${st.Approved ? " [approved]" : " [pending]"}`,
          resp, raw === true,
        );
      }),
  );

  // ---- get stock take ----
  server.tool(
    "simpro_get_stock_take",
    "Get full detail of a Simpro stocktake by ID, including items counted and value adjustments.",
    { stockTakeId: idSchema, raw: rawFlagSchema },
    async ({ stockTakeId, raw }) =>
      safeRun(async () => {
        const path = ctx.client.companyPath(ENDPOINTS.stockTakeById(stockTakeId));
        const resp = await ctx.client.get<SimproStockTake>(path);
        return formatRecord(
          `Stocktake #${resp.ID ?? stockTakeId}`,
          resp, resp, raw === true,
        );
      }),
  );
}
