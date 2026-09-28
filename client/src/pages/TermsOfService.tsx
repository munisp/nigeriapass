import { useEffect } from "react";
import { Link } from "wouter";
import { ArrowLeft, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function TermsOfService() {
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
            <FileText className="w-5 h-5 text-primary" />
            <span className="font-semibold text-lg">Terms of Service</span>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-10 space-y-8">
        <div>
          <p className="text-sm text-muted-foreground">Last updated: March 2026</p>
          <h1 className="text-3xl font-bold mt-2">NigerianPass Terms of Service</h1>
          <p className="mt-4 text-muted-foreground leading-relaxed">
            These Terms of Service ("Terms") govern your access to and use of the NigerianPass onboarding
            portal, mobile application, NFC toll payment system, and related services (the "Platform")
            operated by NigerianPass Technology Limited ("NigerianPass", "we", "us", or "our").
            By creating an account or using the Platform, you agree to be bound by these Terms.
          </p>
        </div>

        <Section title="1. Eligibility">
          <p>
            You must be at least 18 years of age and a resident of Nigeria to use the Platform.
            Fleet operators must be registered legal entities under Nigerian law. By using the Platform,
            you represent that you meet these eligibility requirements.
          </p>
        </Section>

        <Section title="2. Account Registration and KYC">
          <p>
            To access toll payment and wallet features, you must complete our Know Your Customer (KYC)
            verification process, which includes providing accurate identity documents (NIN, driver's licence),
            vehicle information, and completing a liveness check. You are responsible for the accuracy of
            all information submitted. Providing false or misleading information is a violation of these
            Terms and may result in account suspension and referral to relevant authorities.
          </p>
        </Section>

        <Section title="3. NigerianPass Digital Wallet">
          <ul className="list-disc pl-6 space-y-1">
            <li>Your NigerianPass wallet is a stored-value account for toll payment purposes only. It is not a bank account and does not earn interest.</li>
            <li>Wallet top-ups are processed via Paystack, Flutterwave, or Interswitch. Minimum top-up is ₦500; maximum wallet balance is ₦500,000 unless otherwise approved.</li>
            <li>Toll deductions are final and non-reversible except in cases of documented system error. Disputes must be raised within 30 days of the transaction.</li>
            <li>We reserve the right to suspend wallet operations if fraudulent activity is detected.</li>
          </ul>
        </Section>

        <Section title="4. NFC Tag and Device">
          <p>
            Upon successful KYC verification and vehicle registration, NigerianPass will provision an
            NFC tag linked to your registered vehicle(s). You are responsible for the safekeeping of
            your NFC tag. Lost or stolen tags must be reported immediately via the Platform or our
            support line. NigerianPass is not liable for toll charges incurred before a lost/stolen
            tag is deactivated.
          </p>
        </Section>

        <Section title="5. USSD and SMS Services">
          <p>
            NigerianPass provides USSD (*346#) and SMS services for feature phone users. Standard
            telecommunications charges from your mobile network operator may apply. NigerianPass
            is not responsible for service interruptions caused by your network provider.
          </p>
        </Section>

        <Section title="6. Acceptable Use">
          <p>You agree not to:</p>
          <ul className="list-disc pl-6 space-y-1 mt-2">
            <li>Use the Platform for any unlawful purpose or in violation of Nigerian law.</li>
            <li>Attempt to reverse-engineer, decompile, or tamper with the Platform or NFC devices.</li>
            <li>Share your account credentials with third parties.</li>
            <li>Submit fraudulent KYC documents or impersonate another person.</li>
            <li>Use automated scripts or bots to interact with the Platform without prior written consent.</li>
          </ul>
        </Section>

        <Section title="7. Fees and Charges">
          <p>
            Toll charges are set by the relevant road management authority and are subject to change
            without notice. NigerianPass may charge a platform service fee for certain transactions,
            which will be disclosed at the time of the transaction. All fees are denominated in
            Nigerian Naira (NGN) and are inclusive of applicable taxes.
          </p>
        </Section>

        <Section title="8. Intellectual Property">
          <p>
            All content, trademarks, logos, and software on the Platform are the property of
            NigerianPass Technology Limited or its licensors. You may not reproduce, distribute,
            or create derivative works without our prior written consent.
          </p>
        </Section>

        <Section title="9. Limitation of Liability">
          <p>
            To the maximum extent permitted by Nigerian law, NigerianPass shall not be liable for
            any indirect, incidental, special, or consequential damages arising from your use of
            the Platform, including but not limited to loss of revenue, data, or business opportunity.
            Our total liability for any claim shall not exceed the amount you paid to NigerianPass
            in the 30 days preceding the claim.
          </p>
        </Section>

        <Section title="10. Termination">
          <p>
            You may close your account at any time by contacting support. We reserve the right to
            suspend or terminate your account for violation of these Terms, fraudulent activity,
            or at the direction of a competent Nigerian authority. Upon termination, your wallet
            balance (if any) will be refunded to your registered bank account within 14 business days,
            subject to regulatory clearance.
          </p>
        </Section>

        <Section title="11. Governing Law and Dispute Resolution">
          <p>
            These Terms are governed by the laws of the Federal Republic of Nigeria. Any dispute
            arising from these Terms shall first be subject to good-faith negotiation. If unresolved
            within 30 days, disputes shall be referred to arbitration under the Arbitration and
            Conciliation Act (as amended), with the seat of arbitration in Lagos, Nigeria.
          </p>
        </Section>

        <Section title="12. Changes to These Terms">
          <p>
            We may update these Terms from time to time. Material changes will be communicated via
            email or in-app notification at least 14 days before taking effect. Continued use of
            the Platform after the effective date constitutes acceptance of the updated Terms.
          </p>
        </Section>

        <Section title="13. Contact">
          <p>
            For questions about these Terms, contact us at:<br />
            <strong>Email:</strong> legal@nigerianpass.ng<br />
            <strong>Address:</strong> NigerianPass Technology Limited, Plot 1234, Adeola Odeku Street, Victoria Island, Lagos, Nigeria.
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
