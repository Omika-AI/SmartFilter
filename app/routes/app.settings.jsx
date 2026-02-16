import { Form, useActionData, useLoaderData, useNavigation } from "react-router";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const loader = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  let shopRecord = await prisma.shop.findUnique({
    where: { domain: shop },
  });

  if (!shopRecord) {
    shopRecord = await prisma.shop.create({
      data: { domain: shop },
    });
  }

  return {
    enabled: shopRecord.enabled,
    queryCount: shopRecord.queryCount,
  };
};

export const action = async ({ request }) => {
  const { session } = await authenticate.admin(request);
  const shop = session.shop;

  const formData = await request.formData();
  const enabled = formData.get("enabled") === "true";

  await prisma.shop.upsert({
    where: { domain: shop },
    update: { enabled },
    create: { domain: shop, enabled },
  });

  return { success: true };
};

export default function Settings() {
  const { enabled, queryCount } = useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const isSubmitting = navigation.state === "submitting";

  return (
    <s-page title="Settings">
      {actionData?.success && (
        <s-banner tone="success" dismissible>
          Settings saved successfully.
        </s-banner>
      )}

      <s-layout>
        <s-layout-section>
          <s-card>
            <Form method="post">
              <div className="aif-field-stack">
                <h2 className="aif-section-header">AI Filter Settings</h2>

                <s-checkbox
                  name="enabled"
                  label="Enable AI Filter"
                  checked={enabled}
                  value="true"
                >
                  When enabled, customers can use natural language to filter
                  products on collection pages.
                </s-checkbox>

                <p className="aif-helper-text">
                  Total AI queries processed: {queryCount.toLocaleString()}
                </p>
              </div>

              <div className="aif-sticky-footer">
                <s-button type="submit" variant="primary" disabled={isSubmitting}>
                  {isSubmitting ? "Saving..." : "Save"}
                </s-button>
              </div>
            </Form>
          </s-card>
        </s-layout-section>
      </s-layout>
    </s-page>
  );
}
