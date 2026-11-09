import type { Metadata } from "next";
import type { ReactNode } from "react";

import { JourneyProvider } from "./_journey/journey-context";
import "./globals.css";

export const metadata: Metadata = {
  title: "PactPay Arena",
  description: "Agents negotiate. Code enforces. PayPal settles. (PayPal Sandbox demo)",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a className="skip" href="#main">
          Skip to the main content
        </a>
        <JourneyProvider>{children}</JourneyProvider>
      </body>
    </html>
  );
}
