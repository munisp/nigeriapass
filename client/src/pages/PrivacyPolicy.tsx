import { useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function PrivacyPolicy() {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground">
      {/* Header */}
      <div className="sticky top-0 z-10 bg-background/80 backdrop-blur border-b border-border">
        <div className="max-w-3xl mx-auto px-4 py-4 flex items-center gap-3">
          <Link href="/">
            <Button variant="ghost" size="sm" className="gap-2">
              <ArrowLeft className="w-4 h-4" />
              Back
            </Button>
          </Link>
          <div className="flex items-center gap-2">
            <Shield className="w-5 h-5 text-primary" />
            <span className="font-semibold text-lg">Privacy Policy</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
        <div>
          <p className="text-sm text-muted-foreground">Last updated: March 2026</p>
          <h1 className="text-3xl font-bold mt-2">NigerianPass Privacy Policy</h1>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            NigerianPass Technology Limited ("NigerianPass", "we", "us", or "our") is committed to protecting
            your personal information. This Privacy Policy explains how we collect, use, disclose, and safeguard
            your data when you use our onboarding portal, mobile application, and related services
            (collectively, the "Platform").
          </p>
        </div>

        <Section title="1. Information We Collect">
          <p>We collect the following categories of personal data:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Identity data:</strong> Full name, date of birth, National Identification Number (NIN), driver's licence number, Tax Identification Number (TIN), and biometric facial images captured during liveness verification.</li>
            <li><strong>Vehicle data:</strong> Plate number, vehicle make, model, year, colour, engine number, chassis number, and FRSC registration status.</li>
            <li><strong>Fleet / corporate data:</strong> Business name, RC number, CAC certificate, fleet size, and authorised signatory information.</li>
            <li><strong>Contact data:</strong> Phone number, email address, and residential address.</li>
            <li><strong>Financial data:</strong> Wallet balance, transaction history, top-up records, and toll payment logs. We do not store full card numbers.</li>
            <li><strong>Device and usage data:</strong> IP address, device identifiers, browser type, NFC tag identifiers, and platform interaction logs.</li>
          </ul>
        </Section>

        <Section title="2. How We Use Your Information">
          <ul className="list-disc pl-6 space-y-1">
            <li>To verify your identity and process KYC/KYB applications as required by the Federal Road Safety Corps (FRSC) and relevant Nigerian regulations.</li>
            <li>To provision and manage your NigerianPass NFC tag and digital wallet.</li>
            <li>To process toll payments and maintain accurate transaction records.</li>
            <li>To send OTP codes, transaction alerts, and service notifications via SMS and email.</li>
            <li>To detect and prevent fraud, money laundering, and unauthorised access.</li>
            <li>To comply with applicable Nigerian laws, including the Nigeria Data Protection Act 2023 (NDPA) and FRSC regulations.</li>
          </ul>
        </Section>

        <Section title="3. Legal Basis for Processing">
          <p>We process your personal data on the following legal bases under the NDPA 2023:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li><strong>Contract performance:</strong> Processing necessary to provide the toll payment and access control services you have requested.</li>
            <li><strong>Legal obligation:</strong> Compliance with FRSC, FIRS, and CBN regulatory requirements.</li>
            <li><strong>Legitimate interests:</strong> Fraud prevention, platform security, and service improvement.</li>
            <li><strong>Consent:</strong> For optional marketing communications, which you may withdraw at any time.</li>
          </ul>
        </Section>

        <Section title="4. Data Sharing and Disclosure">
          <p>We may share your data with:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li><strong>FRSC and government agencies:</strong> As required for vehicle registration verification and regulatory compliance.</li>
            <li><strong>Payment processors:</strong> Paystack, Flutterwave, and Interswitch for wallet top-up and toll payment processing.</li>
            <li><strong>Telecommunications providers:</strong> Africa's Talking for OTP delivery and USSD session management.</li>
            <li><strong>Cloud infrastructure providers:</strong> For secure data storage and processing within Nigeria where possible.</li>
            <li><strong>Law enforcement:</strong> Where required by a valid court order or applicable Nigerian law.</li>
          </ul>
          <p className="mt-2">We do not sell your personal data to third parties for marketing purposes.</p>
        </Section>

        <Section title="5. Data Retention">
          <p>
            We retain your personal data for as long as your account is active and for a minimum of seven (7) years
            after account closure to comply with Nigerian financial regulations. Biometric data is retained for
            the duration of your active NigerianPass account and deleted within 30 days of account closure.
          </p>
        </Section>

        <Section title="6. Your Rights Under the NDPA 2023">
          <p>You have the right to:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Access a copy of the personal data we hold about you.</li>
            <li>Request correction of inaccurate or incomplete data.</li>
            <li>Request deletion of your data (subject to regulatory retention requirements).</li>
            <li>Object to or restrict certain processing activities.</li>
            <li>Withdraw consent for optional processing at any time.</li>
            <li>Lodge a complaint with the Nigeria Data Protection Commission (NDPC).</li>
          </ul>
          <p className="mt-2">To exercise these rights, contact our Data Protection Officer at <strong>dpo@nigerianpass.ng</strong>.</p>
        </Section>

        <Section title="7. Security">
          <p>
            We implement industry-standard security measures including AES-256 encryption at rest,
            TLS 1.3 in transit, HKDF-derived NFC session keys, multi-factor authentication for
            administrative access, and regular penetration testing. However, no system is completely
            immune to security risks, and we encourage you to keep your login credentials confidential.
          </p>
        </Section>

        <Section title="8. Cookies and Tracking">
          <p>
            Our web portal uses essential session cookies for authentication and security. We do not
            use third-party advertising cookies. Analytics data is collected in aggregate form to
            improve platform performance and does not identify individual users.
          </p>
        </Section>

        <Section title="9. Changes to This Policy">
          <p>
            We may update this Privacy Policy periodically. Material changes will be communicated
            via email or an in-app notification at least 14 days before taking effect. Continued use
            of the Platform after the effective date constitutes acceptance of the updated policy.
          </p>
        </Section>

        <Section title="10. Contact Us">
          <p>
            For privacy-related enquiries, contact our Data Protection Officer:<br />
            <strong>Email:</strong> dpo@nigerianpass.ng<br />
            <strong>Address:</strong> NigerianPass Technology Limited, Plot 1234, Adeola Odeku Street, Victoria Island, Lagos, Nigeria.<br />
            <strong>Phone:</strong> +234 (0) 1 234 5678
          </p>
        </Section>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-xl font-semibold border-b border-border pb-2">{title}</h2>
      <div className="text-muted-foreground leading-relaxed space-y-2">{children}</div>
    </section>
  );
}
