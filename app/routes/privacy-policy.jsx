export default function PrivacyPolicy() {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Privacy Policy - SmartFilter</title>
        <style
          dangerouslySetInnerHTML={{
            __html: `
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
                max-width: 800px;
                margin: 0 auto;
                padding: 40px 20px;
                line-height: 1.7;
                color: #1a1a1a;
                background: #fff;
              }
              h1 { font-size: 28px; margin-bottom: 8px; }
              h2 { font-size: 20px; margin-top: 32px; }
              p, li { font-size: 15px; color: #333; }
              .updated { color: #666; font-size: 14px; margin-bottom: 32px; }
              a { color: #5c6ac4; }
            `,
          }}
        />
      </head>
      <body>
        <h1>Privacy Policy</h1>
        <p className="updated">Last updated: February 16, 2026</p>

        <p>
          SmartFilter ("we", "our", or "the app") is operated by Omika AI. This
          privacy policy explains how we collect, use, and protect information
          when you install and use SmartFilter on your Shopify store.
        </p>

        <h2>1. Information We Collect</h2>
        <p>When you install SmartFilter, we access the following data through Shopify's API:</p>
        <ul>
          <li>
            <strong>Product data:</strong> Product titles, descriptions, types,
            tags, and categories from your Shopify store catalog. This is used
            solely to power the AI search and filtering functionality.
          </li>
          <li>
            <strong>Store information:</strong> Your store domain and Shopify
            session data required for app authentication.
          </li>
        </ul>
        <p>
          We do <strong>not</strong> collect any personal information from your
          customers. Search queries entered by customers on your storefront are
          processed in real time and are not stored or logged.
        </p>

        <h2>2. How We Use Your Information</h2>
        <ul>
          <li>To provide AI-powered product search and filtering on your storefront</li>
          <li>To match customer search queries to your product catalog</li>
          <li>To authenticate and maintain your app session</li>
        </ul>

        <h2>3. Third-Party Services</h2>
        <p>
          SmartFilter uses a third-party AI service (OpenRouter) to process
          search queries. Only the customer's search query and your product
          category data are sent to this service. No personally identifiable
          information is shared.
        </p>

        <h2>4. Data Storage and Security</h2>
        <p>
          Session data is stored securely using Shopify's recommended session
          storage. We do not maintain a separate database of your customer data.
          Product data is fetched from Shopify in real time and cached
          temporarily in memory for performance.
        </p>

        <h2>5. Data Retention</h2>
        <p>
          We retain your Shopify session data only while the app is installed.
          When you uninstall SmartFilter, all associated session data is
          automatically deleted.
        </p>

        <h2>6. Your Rights</h2>
        <p>
          You can uninstall SmartFilter at any time from your Shopify admin,
          which removes all stored data. For any data-related requests, contact
          us at the address below.
        </p>

        <h2>7. Changes to This Policy</h2>
        <p>
          We may update this privacy policy from time to time. Any changes will
          be reflected on this page with an updated date.
        </p>

        <h2>8. Contact Us</h2>
        <p>
          If you have questions about this privacy policy, please contact us
          at: <a href="mailto:support@omika.ai">support@omika.ai</a>
        </p>
      </body>
    </html>
  );
}
