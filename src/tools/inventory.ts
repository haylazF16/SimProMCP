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
import { idSchema, rawFlagSchema, rawPayloadSchema, confirmSchema } from "../utils/schemas.js";
import { pruneEmpty } from "../utils/sanitise.js";
import { extractList, formatList, formatRecord, safeRun, ToolCtx, writeGuard } from "./_shared.js";

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

  // ---- create catalog item ----
  // Verified live: POST /catalogs/ requires only Name. PartNo, Group,
  // TradePrice, Manufacturer etc. are all optional. Group must be a valid
  // catalogGroup ID (use Simpro's web UI to discover commonly-used groups
  // for your business — common Goldman group IDs include 28=COOKS).
  //
  // Strongly recommended workflow when adding a part that came from a
  // supplier quote:
  //   1. simpro_search_catalog with the partNo first to avoid duplicates
  //   2. If no result, call this tool with at least PartNo + Name + TradePrice
  //   3. The returned catalogId can then be used in simpro_add_purchase_order_item
  server.tool(
    "simpro_create_catalog_item",
    "Create a new item in the Simpro parts catalog. Use this when a part on a supplier quote isn't already in Simpro's catalog. Required: name. Strongly recommended: partNo, tradePrice. Honors SIMPRO_ENABLE_WRITE_TOOLS / SIMPRO_DRY_RUN. Always search first with simpro_search_catalog to avoid creating duplicates.",
    {
      confirm: confirmSchema,
      name: z.string().min(1)
        .describe("The part's display name. Required. e.g. '2-pt Output Module'."),
      partNo: z.string().optional()
        .describe("Manufacturer or supplier part number. e.g. 'FC6A-K2A1'. Strongly recommended for searching later."),
      tradePrice: z.number().nonnegative().optional()
        .describe("Cost price ex-tax. Used for PO defaults and margin calculations."),
      manufacturer: z.string().optional(),
      upc: z.string().optional()
        .describe("Universal Product Code / barcode."),
      countryOfOrigin: z.string().optional(),
      markup: z.number().nonnegative().optional()
        .describe("Markup percentage applied to derive sell price (e.g. 30 for 30%)."),
      sellPrice: z.number().nonnegative().optional()
        .describe("Customer sell price ex-tax. If omitted, derived from tradePrice + markup."),
      isInventory: z.boolean().optional()
        .describe("Track stock for this item? Defaults to true in Simpro."),
      group: z.union([z.number(), z.string()]).optional()
        .describe("Catalog group ID (categorisation). Must be an existing group from Simpro setup."),
      storageLocation: z.string().optional()
        .describe("Free-text location e.g. 'Bin A3'."),
      notes: z.string().optional(),
      rawPayload: rawPayloadSchema,
    },
    async (args) =>
      safeRun(async () => {
        const payload = args.rawPayload ?? pruneEmpty({
          Name: args.name,
          PartNo: args.partNo,
          TradePrice: args.tradePrice,
          Manufacturer: args.manufacturer,
          UPC: args.upc,
          CountryOfOrigin: args.countryOfOrigin,
          Markup: args.markup,
          SellPrice: args.sellPrice,
          IsInventory: args.isInventory,
          Group: args.group !== undefined ? Number(args.group) : undefined,
          StorageLocation: args.storageLocation,
          Notes: args.notes,
        });
        const path = ctx.client.companyPath(ENDPOINTS.catalogs);
        const blocked = writeGuard(ctx, {
          confirm: args.confirm,
          method: "POST",
          path,
          payload,
          summary: `Create catalog item "${args.name}"${args.partNo ? ` (${args.partNo})` : ""}`,
        });
        if (blocked) return blocked;
        const resp = await ctx.client.post<SimproCatalog>(path, payload);
        return formatRecord(
          `Created catalog item #${resp.ID ?? "?"}: ${resp.PartNo ? `[${resp.PartNo}] ` : ""}${resp.Name ?? args.name}.\n` +
          `Use catalogId=${resp.ID} when adding to a purchase order.`,
          resp, resp, true,
        );
      }),
  );

  // (No simpro_update_catalog_item yet. Use rawPayload via simpro_create_catalog_item
  // with the same PartNo, or edit in the Simpro web UI. Add this if needed.)

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
