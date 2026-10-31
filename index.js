import { randomUUID } from "node:crypto";

const SHOP = process.env.SHOPIFY_SHOP;
const CLIENT_ID = process.env.SHOPIFY_CLIENT_ID;
const CLIENT_SECRET = process.env.SHOPIFY_CLIENT_SECRET;

const HN_API_URL = process.env.HN_API_URL;
const HN_USERNAME = process.env.HN_USERNAME;
const HN_PASSWORD = process.env.HN_PASSWORD;

const LOCATION_ID = process.env.SHOPIFY_LOCATION_ID;
const API_VERSION = "2026-10";
const DRY_RUN = (process.env.DRY_RUN ?? "true") === "true";

function required(value, name) {
  if (!value) throw new Error(`Trūksta nustatymo: ${name}`);
  return value;
}

async function request(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(30000)
  });

  const body = await response.text();

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${body.slice(0, 500)}`);
  }

  return JSON.parse(body);
}

async function getShopifyToken() {
  const url = `https://${SHOP}/admin/oauth/access_token`;

  const data = await request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      grant_type: "client_credentials"
    })
  });

  if (!data.access_token) {
    throw new Error("Shopify negrąžino prieigos rakto.");
  }

  return data.access_token;
}

async function getHouseNordicStock() {
  const url = new URL(required(HN_API_URL, "HN_API_URL"));
  url.searchParams.set("username", HN_USERNAME);
  url.searchParams.set("password", HN_PASSWORD);
  url.searchParams.set("sku", "all");
  url.searchParams.set("mode", "json");

  const data = await request(url);

  if (!Array.isArray(data.products) || data.products.length === 0) {
    throw new Error("House Nordic negrąžino tinkamo prekių sąrašo.");
  }

  const stockBySku = new Map();

  for (const product of data.products) {
    const sku = String(product.sku ?? "").trim();
    const quantity = Number(product.stock);

    if (!sku || !Number.isSafeInteger(quantity) || quantity < 0) {
      throw new Error("House Nordic grąžino netinkamą SKU arba likutį.");
    }

    if (stockBySku.has(sku)) {
      throw new Error(`Pasikartojantis House Nordic SKU: ${sku}`);
    }

    stockBySku.set(sku, quantity);
  }

  return stockBySku;
}

async function getShopifyVariants(token) {
  const query = `
    query GetVariants($after: String) {
      productVariants(first: 250, after: $after) {
        edges {
          cursor
          node {
            sku
            inventoryItem {
              id
              tracked
            }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  `;

  const variants = [];
  let after = null;

  while (true) {
    const result = await shopifyGraphQL(token, query, { after });
    const connection = result.productVariants;

    variants.push(...connection.edges.map(edge => edge.node));

    if (!connection.pageInfo.hasNextPage) break;
    after = connection.pageInfo.endCursor;
  }

  return variants;
}

async function shopifyGraphQL(token, query, variables = {}) {
  const url = `https://${SHOP}/admin/api/${API_VERSION}/graphql.json`;

  const data = await request(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token
    },
    body: JSON.stringify({ query, variables })
  });

  if (data.errors?.length) {
    throw new Error(JSON.stringify(data.errors));
  }

  return data.data;
}

async function updateShopify(token, updates) {
  const mutation = `
    mutation SetInventory(
      $input: InventorySetQuantitiesInput!,
      $idempotencyKey: String!
    ) {
      inventorySetQuantities(input: $input)
        @idempotent(key: $idempotencyKey) {
        userErrors {
          field
          message
          code
        }
      }
    }
  `;

  for (let i = 0; i < updates.length; i += 100) {
    const batch = updates.slice(i, i + 100);

    const variables = {
      idempotencyKey: randomUUID(),
      input: {
        name: "available",
        reason: "correction",
        quantities: batch.map(item => ({
          inventoryItemId: item.inventoryItemId,
          locationId: LOCATION_ID,
          quantity: item.quantity,
          changeFromQuantity: null
        }))
      }
    };

    const result = await shopifyGraphQL(token, mutation, variables);
    const errors = result.inventorySetQuantities.userErrors;

    if (errors.length) {
      throw new Error(`Shopify likučių klaidos: ${JSON.stringify(errors)}`);
    }
  }
}

async function main() {
  required(SHOP, "SHOPIFY_SHOP");
  required(CLIENT_ID, "SHOPIFY_CLIENT_ID");
  required(CLIENT_SECRET, "SHOPIFY_CLIENT_SECRET");
  required(HN_USERNAME, "HN_USERNAME");
  required(HN_PASSWORD, "HN_PASSWORD");
  required(LOCATION_ID, "SHOPIFY_LOCATION_ID");

  console.log("Pradedama House Nordic likučių sinchronizacija.");

  const supplierStock = await getHouseNordicStock();
  console.log(`Gauta House Nordic SKU: ${supplierStock.size}`);

  const token = await getShopifyToken();
  const variants = await getShopifyVariants(token);

  const updates = [];

  for (const variant of variants) {
    const sku = String(variant.sku ?? "").trim();

    if (!sku || !variant.inventoryItem.tracked) continue;
    if (!supplierStock.has(sku)) continue;

    updates.push({
      sku,
      inventoryItemId: variant.inventoryItem.id,
      quantity: supplierStock.get(sku)
    });
  }

  console.log(`Rasta atitinkančių Shopify prekių: ${updates.length}`);

  if (updates.length === 0) {
    throw new Error("Nerasta nė vienos atitinkančios prekės. Nieko neatnaujiname.");
  }

  if (DRY_RUN) {
    console.log("BANDOMASIS REŽIMAS – Shopify likučiai nekeičiami.");
    console.log(JSON.stringify(updates.slice(0, 10), null, 2));
    return;
  }

  await updateShopify(token, updates);
  console.log(`Atnaujinta prekių likučių: ${updates.length}`);
}

main().catch(error => {
  console.error("SINCHRONIZACIJA NEPAVYKO:", error.message);
  process.exitCode = 1;
});
