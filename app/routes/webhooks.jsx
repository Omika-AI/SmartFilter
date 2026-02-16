import db from "../db.server";
import { authenticate } from "../shopify.server";

export const action = async ({ request }) => {
  const { shop, topic, payload, session } =
    await authenticate.webhook(request);

  console.log(`Received ${topic} webhook for ${shop}`);

  switch (topic) {
    case "APP_UNINSTALLED":
      await handleAppUninstalled(shop);
      break;

    case "APP_SCOPES_UPDATE":
      await handleAppScopesUpdate(shop, payload);
      break;

    case "CUSTOMERS_DATA_REQUEST":
    case "CUSTOMERS_REDACT":
      break;

    case "SHOP_REDACT":
      await handleShopRedact(shop);
      break;

    case "PRODUCTS_CREATE":
    case "PRODUCTS_UPDATE":
    case "PRODUCTS_DELETE":
      await handleProductChange(shop);
      break;

    default:
      throw new Response("Unhandled webhook topic", { status: 404 });
  }

  throw new Response();
};

async function handleProductChange(shop) {
  if (!shop) return;

  try {
    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });
    if (shopRecord) {
      await db.shop.update({
        where: { domain: shop },
        data: { taxonomySyncedAt: null },
      });
      console.log(`[Webhook] Invalidated taxonomy for ${shop}`);
    }
  } catch (error) {
    console.error(`[Webhook] Error invalidating taxonomy for ${shop}:`, error);
  }
}

async function handleAppUninstalled(shop) {
  if (!shop) return;

  try {
    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });
    if (shopRecord) {
      await db.shop.delete({ where: { domain: shop } });
      console.log(`Deleted shop record for uninstalled shop: ${shop}`);
    }

    await db.session.deleteMany({ where: { shop } });
    console.log(`Deleted sessions for uninstalled shop: ${shop}`);
  } catch (error) {
    console.error(`Error cleaning up data for ${shop}:`, error);
  }
}

async function handleAppScopesUpdate(shop, payload) {
  const current = payload.current;

  if (!shop || !current) return;

  try {
    const session = await db.session.findFirst({ where: { shop } });
    if (session) {
      await db.session.update({
        where: { id: session.id },
        data: { scope: current.toString() },
      });
      console.log(`Updated scopes for shop: ${shop}`);
    }
  } catch (error) {
    console.error(`Error updating scopes for ${shop}:`, error);
  }
}

async function handleShopRedact(shop) {
  try {
    const shopRecord = await db.shop.findUnique({ where: { domain: shop } });
    if (shopRecord) {
      await db.shop.delete({ where: { domain: shop } });
      console.log(`Deleted shop and all related data for: ${shop}`);
    }

    await db.session.deleteMany({ where: { shop } });
    console.log(`Deleted sessions for: ${shop}`);
  } catch (error) {
    console.error(`Error deleting data for shop ${shop}:`, error);
  }
}
