import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Building2, FileText, Users, CheckCircle2, ArrowRight, ArrowLeft, AlertCircle, Loader2, Upload, CreditCard } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";
import { useKycDraftSync, isNetworkError } from "@/hooks/useKycDraftSync";

const STEPS = [
  { id: 1, label: "Company Info", icon: Building2 },
  { id: 2, label: "Contact Person", icon: Users },
  { id: 3, label: "Documents", icon: FileText },
  { id: 4, label: "Account Setup", icon: CreditCard },
  { id: 5, label: "Review", icon: CheckCircle2 },
];

const companySchema = z.object({
  companyName: z.string().min(3, "Company name required"),
  cacNumber: z.string().min(6, "CAC number required"),
  tinNumber: z.string().regex(/^\d{8}$/, "TIN must be 8 digits"),
  rcNumber: z.string().min(4, "RC number required"),
  businessType: z.enum(["limited", "plc", "sole", "partnership", "ngo"]),
  industry: z.string().min(1, "Industry required"),
  address: z.string().min(10, "Full address required"),
  state: z.string().min(1, "State required"),
  website: z.string().url("Enter a valid URL").optional().or(z.literal("")),
});

const contactSchema = z.object({
  contactName: z.string().min(2, "Contact name required"),
  contactTitle: z.string().min(2, "Job title required"),
  contactPhone: z.string().regex(/^(\+234|0)[789]\d{9}$/, "Valid Nigerian phone required"),
  contactEmail: z.string().email("Valid email required"),
  contactNIN: z.string().regex(/^\d{11}$/, "NIN must be 11 digits"),
});

const NIGERIAN_STATES = ["Abia","Adamawa","Akwa Ibom","Anambra","Bauchi","Bayelsa","Benue","Borno","Cross River","Delta","Ebonyi","Edo","Ekiti","Enugu","FCT Abuja","Gombe","Imo","Jigawa","Kaduna","Kano","Katsina","Kebbi","Kogi","Kwara","Lagos","Nasarawa","Niger","Ogun","Ondo","Osun","Oyo","Plateau","Rivers","Sokoto","Taraba","Yobe","Zamfara"];

const FLEET_DOCS = [
  { id: "cac_cert", label: "CAC Certificate of Incorporation", required: true },
  { id: "tin_cert", label: "FIRS Tax Identification Certificate", required: true },
  { id: "utility_bill", label: "Utility Bill (business address)", required: true },
  { id: "board_resolution", label: "Board Resolution / Authorisation Letter", required: false },
  { id: "audited_accounts", label: "Audited Financial Accounts (last 2 years)", required: false },
];

type CompanyData = z.infer<typeof companySchema>;
type ContactData = z.infer<typeof contactSchema>;

export default function FleetKYB() {
  const [step, setStep] = useState(1);
  const [companyData, setCompanyData] = useState<CompanyData | null>(null);
  const [contactData, setContactData] = useState<ContactData | null>(null);
  // Documents are registered locally as "queued" — the server accepts the
  // document IDs on submit and processes the files server-side.
  const [uploadedDocs, setUploadedDocs] = useState<Record<string, { name: string; status: "queued" | "failed" }>>({});
  const [creditLimit, setCreditLimit] = useState("500000");
  const [customCreditLimit, setCustomCreditLimit] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [applicationId, setApplicationId] = useState("");

  const submitFleetKYB = trpc.kyc.submitFleetKYB.useMutation();
  const { queueDraft, queuedDraftCount, isReplaying } = useKycDraftSync();

  const companyForm = useForm<CompanyData>({ resolver: zodResolver(companySchema) });
  const contactForm = useForm<ContactData>({ resolver: zodResolver(contactSchema) });
  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  const handleFileUpload = (docId: string, file: File) => {
    setUploadedDocs(prev => ({ ...prev, [docId]: { name: file.name, status: "queued" } }));
    toast.info(`${file.name} queued`, {
      description: "It will be uploaded when your application is submitted.",
    });
  };

  const handleSubmit = async () => {
    if (!companyData || !contactData) return;

    // Resolve the requested credit limit — "custom" requires a valid amount
    let creditLimitRequested: number | undefined;
    if (creditLimit === "custom") {
      const parsed = Number(customCreditLimit.replace(/[^\d]/g, ""));
      if (!Number.isFinite(parsed) || parsed <= 0) {
        toast.error("Enter a valid custom credit limit (whole naira amount)");
        setStep(4);
        return;
      }
      creditLimitRequested = parsed;
    } else {
      const parsed = parseInt(creditLimit, 10);
      creditLimitRequested = Number.isFinite(parsed) ? parsed : undefined;
    }

    const payload = {
      companyName: companyData.companyName,
      cacNumber: companyData.cacNumber,
      tinNumber: companyData.tinNumber,
      rcNumber: companyData.rcNumber,
      businessType: companyData.businessType,
      industry: companyData.industry,
      address: companyData.address,
      state: companyData.state,
      website: companyData.website || "",
      contactName: contactData.contactName,
      contactTitle: contactData.contactTitle,
      contactPhone: contactData.contactPhone,
      contactEmail: contactData.contactEmail,
      contactNIN: contactData.contactNIN,
      creditLimitRequested,
      uploadedDocIds: Object.entries(uploadedDocs)
        .filter(([, v]) => v.status === "queued")
        .map(([k]) => k),
    };

    // Offline / unreachable server → queue for automatic replay.
    // Validation errors are shown honestly and nothing is queued.
    const queueForLater = async () => {
      await queueDraft({
        type: "fleet",
        formData: payload as Record<string, unknown>,
        clientVersion: 1,
        draftId: `fleet-${companyData.cacNumber}`,
      });
    };

    try {
      if (!navigator.onLine) {
        await queueForLater();
        return;
      }
      const result = await submitFleetKYB.mutateAsync(payload);
      setApplicationId(result.referenceId);
      setSubmitted(true);
      toast.success(`Fleet KYB submitted! Reference: ${result.referenceId}`);
    } catch (err: unknown) {
      if (isNetworkError(err)) {
        await queueForLater();
      } else {
        toast.error("Submission failed", {
          description: (err as Error)?.message ?? "Please review your details and try again.",
        });
      }
    }
  };

  if (submitted) {
    return (
      <PortalLayout title="Fleet KYB" subtitle="Submitted">
        <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)] p-6">
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className="max-w-md w-full bg-white rounded-2xl border border-border p-8 text-center shadow-xl">
            <div className="w-20 h-20 rounded-full bg-amber-100 flex items-center justify-center mx-auto mb-6">
              <Building2 className="w-10 h-10 text-amber-600" />
            </div>
            <h2 className="text-2xl font-bold mb-2" style={{ fontFamily: 'Sora, sans-serif' }}>KYB Application Submitted!</h2>
            <p className="text-muted-foreground mb-6">Your business verification is under review. A dedicated account manager will contact you within 3–5 business days.</p>
            <div className="bg-muted rounded-xl p-4 mb-6">
              <div className="text-xs text-muted-foreground mb-1">Application Reference</div>
              <div className="text-lg font-bold font-mono">{applicationId}</div>
            </div>
            <Button className="w-full" onClick={() => { setSubmitted(false); setStep(1); }}>Submit Another Application</Button>
          </motion.div>
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout title="Fleet KYB Onboarding" subtitle="Business verification for fleet operators">
      <div className="max-w-3xl mx-auto p-4 md:p-6 lg:p-8">
        {/* Progress */}
        <div className="bg-white rounded-2xl border border-border p-5 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Step {step} of {STEPS.length}: {STEPS[step-1].label}</h2>
          </div>
          <div className="h-2 bg-muted rounded-full overflow-hidden mb-3">
            <motion.div className="h-full np-progress-bar" animate={{ width: `${progress}%` }} transition={{ duration: 0.5 }} />
          </div>
          <div className="flex justify-between">
            {STEPS.map(s => (
              <div key={s.id} className="flex flex-col items-center gap-1">
                <div className={cn("w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold transition-all",
                  s.id < step ? "np-step-complete" : s.id === step ? "np-step-active" : "np-step-pending")}>
                  {s.id < step ? <CheckCircle2 className="w-4 h-4" /> : s.id}
                </div>
                <span className="text-[10px] text-muted-foreground hidden sm:block">{s.label}</span>
              </div>
            ))}
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={step} initial={{ opacity: 0, x: 30 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -30 }} transition={{ duration: 0.25 }}>

            {/* STEP 1: Company Info */}
            {step === 1 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
                    <Building2 className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Company Information</h3>
                    <p className="text-sm text-muted-foreground">Enter your registered business details as they appear on your CAC certificate</p>
                  </div>
                </div>
                <form onSubmit={companyForm.handleSubmit(d => { setCompanyData(d); setStep(2); })} className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Registered Company Name</Label>
                    <Input {...companyForm.register("companyName")} placeholder="Eko Transport Limited" className="h-10" />
                    {companyForm.formState.errors.companyName && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{companyForm.formState.errors.companyName.message}</p>}
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">CAC Number</Label>
                      <Input {...companyForm.register("cacNumber")} placeholder="RC123456" className="h-10" />
                      <p className="text-xs text-muted-foreground">Verified with the Corporate Affairs Commission after submission.</p>
                      {companyForm.formState.errors.cacNumber && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{companyForm.formState.errors.cacNumber.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">TIN (FIRS)</Label>
                      <Input {...companyForm.register("tinNumber")} placeholder="12345678" maxLength={8} className="h-10 font-mono" />
                      {companyForm.formState.errors.tinNumber && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{companyForm.formState.errors.tinNumber.message}</p>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">RC Number</Label>
                      <Input {...companyForm.register("rcNumber")} placeholder="RC1234567" className="h-10" />
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Business Type</Label>
                      <Select onValueChange={v => companyForm.setValue("businessType", v as CompanyData["businessType"])}>
                        <SelectTrigger className="h-10"><SelectValue placeholder="Select type" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="limited">Private Limited (Ltd)</SelectItem>
                          <SelectItem value="plc">Public Limited (PLC)</SelectItem>
                          <SelectItem value="sole">Sole Proprietorship</SelectItem>
                          <SelectItem value="partnership">Partnership</SelectItem>
                          <SelectItem value="ngo">NGO / Non-Profit</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Industry</Label>
                      <Select onValueChange={v => companyForm.setValue("industry", v)}>
                        <SelectTrigger className="h-10"><SelectValue placeholder="Select industry" /></SelectTrigger>
                        <SelectContent>
                          {["Transportation & Logistics","Oil & Gas","Construction","Agriculture","Healthcare","Education","Retail & FMCG","Technology","Finance","Other"].map(i => <SelectItem key={i} value={i}>{i}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">State</Label>
                      <Select onValueChange={v => companyForm.setValue("state", v)}>
                        <SelectTrigger className="h-10"><SelectValue placeholder="Select state" /></SelectTrigger>
                        <SelectContent className="max-h-52">{NIGERIAN_STATES.map(s => <SelectItem key={s} value={s}>{s}</SelectItem>)}</SelectContent>
                      </Select>
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Registered Address</Label>
                    <Input {...companyForm.register("address")} placeholder="Plot 1, Adeola Odeku Street, Victoria Island, Lagos" className="h-10" />
                    {companyForm.formState.errors.address && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{companyForm.formState.errors.address.message}</p>}
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Website (Optional)</Label>
                    <Input {...companyForm.register("website")} placeholder="https://www.company.com" className="h-10" />
                  </div>
                  <div className="flex justify-end pt-2">
                    <Button type="submit" className="bg-amber-600 hover:bg-amber-700 gap-2">Continue <ArrowRight className="w-4 h-4" /></Button>
                  </div>
                </form>
              </div>
            )}

            {/* STEP 2: Contact Person */}
            {step === 2 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
                    <Users className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Authorised Contact Person</h3>
                    <p className="text-sm text-muted-foreground">The person authorised to manage this fleet account</p>
                  </div>
                </div>
                <form onSubmit={contactForm.handleSubmit(d => { setContactData(d); setStep(3); })} className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Full Name</Label>
                      <Input {...contactForm.register("contactName")} placeholder="Ngozi Adeyemi" className="h-10" />
                      {contactForm.formState.errors.contactName && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{contactForm.formState.errors.contactName.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Job Title</Label>
                      <Input {...contactForm.register("contactTitle")} placeholder="Fleet Manager" className="h-10" />
                      {contactForm.formState.errors.contactTitle && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{contactForm.formState.errors.contactTitle.message}</p>}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Phone Number</Label>
                      <Input {...contactForm.register("contactPhone")} placeholder="+234 801 234 5678" className="h-10" />
                      {contactForm.formState.errors.contactPhone && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{contactForm.formState.errors.contactPhone.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Email Address</Label>
                      <Input {...contactForm.register("contactEmail")} type="email" placeholder="ngozi@company.com" className="h-10" />
                      {contactForm.formState.errors.contactEmail && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{contactForm.formState.errors.contactEmail.message}</p>}
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Contact Person NIN</Label>
                    <Input {...contactForm.register("contactNIN")} placeholder="12345678901" maxLength={11} className="h-10 font-mono" />
                    {contactForm.formState.errors.contactNIN && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{contactForm.formState.errors.contactNIN.message}</p>}
                  </div>
                  <div className="flex justify-between pt-2">
                    <Button type="button" variant="outline" onClick={() => setStep(1)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                    <Button type="submit" className="bg-amber-600 hover:bg-amber-700 gap-2">Continue <ArrowRight className="w-4 h-4" /></Button>
                  </div>
                </form>
              </div>
            )}

            {/* STEP 3: Documents */}
            {step === 3 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
                    <FileText className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Business Documents</h3>
                    <p className="text-sm text-muted-foreground">Upload required business verification documents</p>
                  </div>
                </div>
                <div className="space-y-3">
                  {FLEET_DOCS.map(doc => {
                    const uploaded = uploadedDocs[doc.id];
                    return (
                      <div key={doc.id} className="np-upload-zone rounded-xl p-4">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <div className={cn("w-9 h-9 rounded-lg flex items-center justify-center", uploaded?.status === "queued" ? "bg-blue-100" : "bg-muted")}>
                              {uploaded?.status === "queued" ? <Upload className="w-5 h-5 text-blue-600" /> :
                               <FileText className="w-5 h-5 text-muted-foreground" />}
                            </div>
                            <div>
                              <div className="text-sm font-medium">{doc.label}{doc.required && <span className="text-red-500 ml-1">*</span>}</div>
                              <div className="text-xs text-muted-foreground">{uploaded ? `${uploaded.name} — queued for upload` : "JPG, PNG, or PDF"}</div>
                            </div>
                          </div>
                          <label className="cursor-pointer">
                            <Button type="button" variant="outline" size="sm" className="h-8 text-xs pointer-events-none">
                              <Upload className="w-3 h-3 mr-1" />{uploaded ? "Replace" : "Upload"}
                            </Button>
                            <input type="file" accept="image/*,.pdf" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) handleFileUpload(doc.id, f); }} />
                          </label>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(2)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                  <Button onClick={() => setStep(4)} className="bg-amber-600 hover:bg-amber-700 gap-2"
                    disabled={FLEET_DOCS.filter(d => d.required).some(d => uploadedDocs[d.id]?.status !== "queued")}>
                    Continue <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* STEP 4: Account Setup */}
            {step === 4 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
                    <CreditCard className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Fleet Account Setup</h3>
                    <p className="text-sm text-muted-foreground">Configure your fleet wallet and credit preferences</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Requested Credit Limit (₦)</Label>
                    <Select value={creditLimit} onValueChange={setCreditLimit}>
                      <SelectTrigger className="h-10"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        <SelectItem value="100000">₦100,000 — Starter</SelectItem>
                        <SelectItem value="500000">₦500,000 — Standard</SelectItem>
                        <SelectItem value="1000000">₦1,000,000 — Business</SelectItem>
                        <SelectItem value="5000000">₦5,000,000 — Enterprise</SelectItem>
                        <SelectItem value="custom">Custom Amount</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  {creditLimit === "custom" && (
                    <div className="space-y-1.5">
                      <Label htmlFor="custom-credit" className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
                        Custom Amount (₦)
                      </Label>
                      <Input
                        id="custom-credit"
                        inputMode="numeric"
                        placeholder="e.g. 750000"
                        value={customCreditLimit}
                        onChange={e => setCustomCreditLimit(e.target.value.replace(/[^\d]/g, ""))}
                        className="h-10 font-mono"
                      />
                      <p className="text-xs text-muted-foreground">
                        Enter a whole naira amount. The credit team reviews all requests during KYB.
                      </p>
                    </div>
                  )}
                  <div className="p-4 bg-amber-50 rounded-xl border border-amber-200">
                    <div className="text-sm font-semibold text-amber-800 mb-1">Fleet Account Benefits</div>
                    <ul className="text-xs text-amber-700 space-y-1">
                      <li>• Centralised wallet for all fleet vehicles</li>
                      <li>• Bulk top-up via bank transfer or USSD</li>
                      <li>• Real-time transaction monitoring per vehicle</li>
                      <li>• Monthly consolidated invoicing for accounting</li>
                      <li>• Dedicated account manager and priority support</li>
                    </ul>
                  </div>
                </div>
                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(3)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                  <Button onClick={() => setStep(5)} className="bg-amber-600 hover:bg-amber-700 gap-2">Continue <ArrowRight className="w-4 h-4" /></Button>
                </div>
              </div>
            )}

            {/* STEP 5: Review */}
            {step === 5 && companyData && contactData && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Review & Submit</h3>
                    <p className="text-sm text-muted-foreground">Confirm your fleet KYB application</p>
                  </div>
                </div>
                <div className="space-y-4">
                  <div className="rounded-xl border border-border overflow-hidden">
                    <div className="bg-muted px-4 py-2.5 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Company</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setStep(1)}>Edit</Button>
                    </div>
                    <div className="p-4 grid grid-cols-2 gap-3">
                      {[
                        { label: "Company Name", value: companyData.companyName },
                        { label: "CAC Number", value: companyData.cacNumber },
                        { label: "TIN", value: companyData.tinNumber },
                        { label: "Business Type", value: companyData.businessType },
                        { label: "State", value: companyData.state },
                        { label: "Industry", value: companyData.industry },
                      ].map(item => (
                        <div key={item.label}>
                          <div className="text-xs text-muted-foreground">{item.label}</div>
                          <div className="text-sm font-medium truncate capitalize">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-border overflow-hidden">
                    <div className="bg-muted px-4 py-2.5 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Contact Person</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setStep(2)}>Edit</Button>
                    </div>
                    <div className="p-4 grid grid-cols-2 gap-3">
                      {[
                        { label: "Name", value: contactData.contactName },
                        { label: "Title", value: contactData.contactTitle },
                        { label: "Phone", value: contactData.contactPhone },
                        { label: "Email", value: contactData.contactEmail },
                      ].map(item => (
                        <div key={item.label}>
                          <div className="text-xs text-muted-foreground">{item.label}</div>
                          <div className="text-sm font-medium truncate">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 flex items-center gap-2">
                    <AlertCircle className="w-4 h-4 text-blue-600" />
                    <span className="text-sm text-blue-700">CAC, TIN and contact NIN will be verified with the relevant registries after submission.</span>
                  </div>
                </div>
                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(4)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                  <div className="flex flex-col items-end gap-1.5">
                    <Button onClick={handleSubmit} className="bg-emerald-600 hover:bg-emerald-700 gap-2" disabled={submitFleetKYB.isPending || isReplaying}>
                      {submitFleetKYB.isPending || isReplaying ? <><Loader2 className="w-4 h-4 animate-spin" />{isReplaying ? "Syncing..." : "Submitting..."}</> : <>Submit KYB Application <CheckCircle2 className="w-4 h-4" /></>}
                    </Button>
                    {queuedDraftCount > 0 && !isReplaying && (
                      <p className="text-xs text-amber-600">{queuedDraftCount} draft{queuedDraftCount > 1 ? "s" : ""} queued — will submit when online</p>
                    )}
                  </div>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </PortalLayout>
  );
}
