import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import {
  Car, FileText, Shield, CheckCircle2, ArrowRight, ArrowLeft,
  AlertCircle, Loader2, Upload, CreditCard
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";
import { useKycDraftSync, isNetworkError } from "@/hooks/useKycDraftSync";

const STEPS = [
  { id: 1, label: "Vehicle Details", icon: Car },
  { id: 2, label: "Documents", icon: FileText },
  { id: 3, label: "Toll Class", icon: CreditCard },
  { id: 4, label: "Review", icon: CheckCircle2 },
];

const vehicleSchema = z.object({
  plateNumber: z.string().min(5, "Enter a valid plate number").max(10),
  make: z.string().min(2, "Vehicle make required"),
  model: z.string().min(1, "Vehicle model required"),
  year: z.string().regex(/^\d{4}$/, "Enter a valid year"),
  colour: z.string().min(2, "Colour required"),
  vehicleType: z.enum(["private", "commercial", "motorcycle", "truck", "bus"]),
  engineNumber: z.string().min(5, "Engine number required"),
  chassisNumber: z.string().min(10, "Chassis number required"),
  ownerNIN: z.string().regex(/^\d{11}$/, "Owner NIN must be 11 digits"),
});

const VEHICLE_TYPES = [
  { value: "private", label: "Private Car", tollClass: "Class 1", rate: "₦350/toll" },
  { value: "commercial", label: "Commercial Vehicle", tollClass: "Class 2", rate: "₦500/toll" },
  { value: "motorcycle", label: "Motorcycle", tollClass: "Class 0", rate: "₦150/toll" },
  { value: "truck", label: "Truck / HGV", tollClass: "Class 3", rate: "₦1,200/toll" },
  { value: "bus", label: "Bus / Coach", tollClass: "Class 2B", rate: "₦700/toll" },
];

const VEHICLE_DOCS = [
  { id: "reg_cert", label: "Vehicle Registration Certificate", required: true },
  { id: "insurance", label: "Third-Party Insurance Certificate", required: true },
  { id: "roadworthiness", label: "Roadworthiness Certificate", required: true },
  { id: "proof_ownership", label: "Proof of Ownership / Purchase Receipt", required: false },
];

type VehicleData = z.infer<typeof vehicleSchema>;

export default function VehicleRegistration() {
  const [step, setStep] = useState(1);
  const [vehicleData, setVehicleData] = useState<VehicleData | null>(null);
  // Documents are registered locally as "queued" — the server accepts the
  // document IDs on submit and processes the files server-side.
  const [uploadedDocs, setUploadedDocs] = useState<Record<string, { name: string; status: "queued" | "failed" }>>({});
  const [selectedTollClass, setSelectedTollClass] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [applicationId, setApplicationId] = useState("");

  const registerVehicle = trpc.kyc.registerVehicle.useMutation();
  const { queueDraft, queuedDraftCount, isReplaying } = useKycDraftSync();

  const form = useForm<VehicleData>({ resolver: zodResolver(vehicleSchema) });
  const progress = ((step - 1) / (STEPS.length - 1)) * 100;

  const handleFileUpload = (docId: string, file: File) => {
    setUploadedDocs(prev => ({ ...prev, [docId]: { name: file.name, status: "queued" } }));
    toast.info(`${file.name} queued`, {
      description: "It will be uploaded when your registration is submitted.",
    });
  };

  const handleSubmit = async () => {
    if (!vehicleData) return;
    const payload = {
      plateNumber: vehicleData.plateNumber.toUpperCase(),
      make: vehicleData.make,
      model: vehicleData.model,
      year: parseInt(vehicleData.year, 10),
      colour: vehicleData.colour,
      vehicleType: vehicleData.vehicleType,
      engineNumber: vehicleData.engineNumber,
      chassisNumber: vehicleData.chassisNumber,
      ownerNIN: vehicleData.ownerNIN,
      tollClass: selectedTollClass
        ? (VEHICLE_TYPES.find(t => t.value === selectedTollClass)?.tollClass ?? selectedTollClass)
        : (selectedType?.tollClass || "Class 1"),
      uploadedDocIds: Object.entries(uploadedDocs)
        .filter(([, v]) => v.status === "queued")
        .map(([k]) => k),
    };

    // Offline / unreachable server → queue for automatic replay.
    // Validation errors are shown honestly and nothing is queued.
    const queueForLater = async () => {
      await queueDraft({
        type: "vehicle",
        formData: payload as Record<string, unknown>,
        clientVersion: 1,
        draftId: `vehicle-${vehicleData.plateNumber}`,
      });
    };

    try {
      if (!navigator.onLine) {
        await queueForLater();
        return;
      }
      const result = await registerVehicle.mutateAsync(payload);
      setApplicationId(result.referenceId);
      setSubmitted(true);
      toast.success(`Vehicle registered! Reference: ${result.referenceId}`);
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

  const selectedType = VEHICLE_TYPES.find(t => t.value === vehicleData?.vehicleType);

  if (submitted) {
    return (
      <PortalLayout title="Vehicle Registration" subtitle="Submitted">
        <div className="flex items-center justify-center min-h-[calc(100vh-3.5rem)] p-6">
          <motion.div initial={{ scale: 0.8, opacity: 0 }} animate={{ scale: 1, opacity: 1 }}
            className="max-w-md w-full bg-white rounded-2xl border border-border p-8 text-center shadow-xl">
            <div className="w-20 h-20 rounded-full bg-blue-100 flex items-center justify-center mx-auto mb-6">
              <Car className="w-10 h-10 text-blue-600" />
            </div>
            <h2 className="text-2xl font-bold text-foreground mb-2" style={{ fontFamily: 'Sora, sans-serif' }}>Vehicle Registered!</h2>
            <p className="text-muted-foreground mb-6">Your vehicle is pending FRSC verification and admin approval. You'll receive an SMS when approved.</p>
            <div className="bg-muted rounded-xl p-4 mb-6">
              <div className="text-xs text-muted-foreground mb-1">Application Reference</div>
              <div className="text-lg font-bold font-mono">{applicationId}</div>
            </div>
            <Button className="w-full" onClick={() => { setSubmitted(false); setStep(1); form.reset(); }}>Register Another Vehicle</Button>
          </motion.div>
        </div>
      </PortalLayout>
    );
  }

  return (
    <PortalLayout title="Vehicle Registration" subtitle="Register your vehicle for NigerianPass toll payments">
      <div className="max-w-3xl mx-auto p-4 md:p-6 lg:p-8">
        {/* Progress */}
        <div className="bg-white rounded-2xl border border-border p-5 mb-6 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-base font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>
              Step {step} of {STEPS.length}: {STEPS[step-1].label}
            </h2>
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

            {/* STEP 1: Vehicle Details */}
            {step === 1 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6 space-y-5">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-xl bg-blue-100 flex items-center justify-center">
                    <Car className="w-5 h-5 text-blue-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Vehicle Details</h3>
                    <p className="text-sm text-muted-foreground">Enter details exactly as on your vehicle registration certificate</p>
                  </div>
                </div>

                <form onSubmit={form.handleSubmit(d => { setVehicleData(d); setStep(2); })} className="space-y-4">
                  {/* Plate number — FRSC verification happens server-side after submission */}
                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Plate Number</Label>
                    <Input {...form.register("plateNumber")} placeholder="ABC-123-XY" className="h-10 font-mono uppercase" />
                    <p className="text-xs text-muted-foreground flex items-center gap-1">
                      <Shield className="w-3 h-3" />The plate will be verified with FRSC after submission — status is shown on your application page.
                    </p>
                    {form.formState.errors.plateNumber && <p className="text-xs text-destructive flex items-center gap-1"><AlertCircle className="w-3 h-3" />{form.formState.errors.plateNumber.message}</p>}
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    {[
                      { name: "make" as const, label: "Make", placeholder: "Toyota" },
                      { name: "model" as const, label: "Model", placeholder: "Camry" },
                      { name: "year" as const, label: "Year", placeholder: "2020" },
                      { name: "colour" as const, label: "Colour", placeholder: "Silver" },
                    ].map(f => (
                      <div key={f.name} className="space-y-1.5">
                        <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{f.label}</Label>
                        <Input {...form.register(f.name)} placeholder={f.placeholder} className="h-10" />
                        {form.formState.errors[f.name] && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{form.formState.errors[f.name]?.message}</p>}
                      </div>
                    ))}
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Vehicle Type</Label>
                    <Select onValueChange={v => form.setValue("vehicleType", v as VehicleData["vehicleType"])}>
                      <SelectTrigger className="h-10"><SelectValue placeholder="Select vehicle type" /></SelectTrigger>
                      <SelectContent>
                        {VEHICLE_TYPES.map(t => (
                          <SelectItem key={t.value} value={t.value}>
                            <div className="flex items-center justify-between gap-4 w-full">
                              <span>{t.label}</span>
                              <span className="text-xs text-muted-foreground">{t.tollClass} · {t.rate}</span>
                            </div>
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>

                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Engine Number</Label>
                      <Input {...form.register("engineNumber")} placeholder="ABC12345678" className="h-10 font-mono text-sm" />
                      {form.formState.errors.engineNumber && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{form.formState.errors.engineNumber.message}</p>}
                    </div>
                    <div className="space-y-1.5">
                      <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Chassis Number (VIN)</Label>
                      <Input {...form.register("chassisNumber")} placeholder="1HGBH41JXMN109186" className="h-10 font-mono text-sm" />
                      {form.formState.errors.chassisNumber && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{form.formState.errors.chassisNumber.message}</p>}
                    </div>
                  </div>

                  <div className="space-y-1.5">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Owner NIN</Label>
                    <Input {...form.register("ownerNIN")} placeholder="12345678901" maxLength={11} className="h-10 font-mono" />
                    {form.formState.errors.ownerNIN && <p className="text-xs text-destructive"><AlertCircle className="w-3 h-3 inline mr-1" />{form.formState.errors.ownerNIN.message}</p>}
                  </div>

                  <div className="flex justify-end pt-2">
                    <Button type="submit" className="bg-blue-600 hover:bg-blue-700 gap-2">Continue <ArrowRight className="w-4 h-4" /></Button>
                  </div>
                </form>
              </div>
            )}

            {/* STEP 2: Documents */}
            {step === 2 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-amber-100 flex items-center justify-center">
                    <FileText className="w-5 h-5 text-amber-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Vehicle Documents</h3>
                    <p className="text-sm text-muted-foreground">Upload all required vehicle documents. Documents are verified by PaddleOCR.</p>
                  </div>
                </div>
                <div className="space-y-3">
                  {VEHICLE_DOCS.map(doc => {
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
                  <Button variant="outline" onClick={() => setStep(1)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                  <Button onClick={() => setStep(3)} className="bg-blue-600 hover:bg-blue-700 gap-2"
                    disabled={VEHICLE_DOCS.filter(d => d.required).some(d => uploadedDocs[d.id]?.status !== "queued")}>
                    Continue <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* STEP 3: Toll Class */}
            {step === 3 && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-purple-100 flex items-center justify-center">
                    <CreditCard className="w-5 h-5 text-purple-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Toll Class Assignment</h3>
                    <p className="text-sm text-muted-foreground">Your toll class determines the rate charged at each plaza</p>
                  </div>
                </div>

                {selectedType && (
                  <div className="mb-6 p-4 rounded-xl bg-blue-50 border border-blue-200">
                    <div className="text-sm font-semibold text-blue-800 mb-1">Auto-assigned based on vehicle type</div>
                    <div className="flex items-center gap-4">
                      <div>
                        <div className="text-xs text-blue-600">Vehicle Type</div>
                        <div className="font-bold text-blue-900">{selectedType.label}</div>
                      </div>
                      <div>
                        <div className="text-xs text-blue-600">Toll Class</div>
                        <div className="font-bold text-blue-900">{selectedType.tollClass}</div>
                      </div>
                      <div>
                        <div className="text-xs text-blue-600">Standard Rate</div>
                        <div className="font-bold text-blue-900">{selectedType.rate}</div>
                      </div>
                    </div>
                  </div>
                )}

                <div className="space-y-3">
                  {VEHICLE_TYPES.map(t => (
                    <div key={t.value} onClick={() => setSelectedTollClass(t.value)}
                      className={cn("p-4 rounded-xl border-2 cursor-pointer transition-all",
                        selectedTollClass === t.value ? "border-blue-500 bg-blue-50" : "border-border hover:border-blue-200")}>
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-3">
                          <div className={cn("w-4 h-4 rounded-full border-2 flex items-center justify-center",
                            selectedTollClass === t.value ? "border-blue-500" : "border-muted-foreground")}>
                            {selectedTollClass === t.value && <div className="w-2 h-2 rounded-full bg-blue-500" />}
                          </div>
                          <div>
                            <div className="font-medium text-sm">{t.label}</div>
                            <div className="text-xs text-muted-foreground">{t.tollClass}</div>
                          </div>
                        </div>
                        <div className="text-sm font-bold text-foreground">{t.rate}</div>
                      </div>
                    </div>
                  ))}
                </div>

                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(2)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                  <Button onClick={() => setStep(4)} className="bg-blue-600 hover:bg-blue-700 gap-2" disabled={!selectedTollClass && !selectedType}>
                    Continue <ArrowRight className="w-4 h-4" />
                  </Button>
                </div>
              </div>
            )}

            {/* STEP 4: Review */}
            {step === 4 && vehicleData && (
              <div className="bg-white rounded-2xl border border-border shadow-sm p-6">
                <div className="flex items-center gap-3 mb-6">
                  <div className="w-10 h-10 rounded-xl bg-emerald-100 flex items-center justify-center">
                    <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                  </div>
                  <div>
                    <h3 className="font-bold" style={{ fontFamily: 'Sora, sans-serif' }}>Review & Submit</h3>
                    <p className="text-sm text-muted-foreground">Confirm vehicle registration details</p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="rounded-xl border border-border overflow-hidden">
                    <div className="bg-muted px-4 py-2.5 flex items-center justify-between">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Vehicle Details</span>
                      <Button variant="ghost" size="sm" className="h-6 text-xs" onClick={() => setStep(1)}>Edit</Button>
                    </div>
                    <div className="p-4 grid grid-cols-2 gap-3">
                      {[
                        { label: "Plate Number", value: vehicleData.plateNumber },
                        { label: "Make & Model", value: `${vehicleData.make} ${vehicleData.model}` },
                        { label: "Year", value: vehicleData.year },
                        { label: "Colour", value: vehicleData.colour },
                        { label: "Engine No.", value: vehicleData.engineNumber },
                        { label: "Chassis (VIN)", value: vehicleData.chassisNumber },
                      ].map(item => (
                        <div key={item.label}>
                          <div className="text-xs text-muted-foreground">{item.label}</div>
                          <div className="text-sm font-medium truncate">{item.value}</div>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="rounded-xl border border-border overflow-hidden">
                    <div className="bg-muted px-4 py-2.5">
                      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Documents</span>
                    </div>
                    <div className="p-4 space-y-2">
                      {VEHICLE_DOCS.map(doc => (
                        <div key={doc.id} className="flex items-center justify-between">
                          <span className="text-sm">{doc.label}</span>
                          {uploadedDocs[doc.id]?.status === "queued" ?
                            <span className="np-status-pending text-xs px-2 py-0.5 rounded-full">Queued for upload</span> :
                            <span className="np-status-pending text-xs px-2 py-0.5 rounded-full">Not selected</span>}
                        </div>
                      ))}
                    </div>
                  </div>

                  {(selectedType || VEHICLE_TYPES.find(t => t.value === vehicleData.vehicleType)) && (
                    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4">
                      <div className="text-xs text-blue-600 mb-1">Assigned Toll Class</div>
                      <div className="font-bold text-blue-900">
                        {(VEHICLE_TYPES.find(t => t.value === (selectedTollClass || vehicleData.vehicleType)))?.tollClass} —{" "}
                        {(VEHICLE_TYPES.find(t => t.value === (selectedTollClass || vehicleData.vehicleType)))?.rate}
                      </div>
                    </div>
                  )}

                  <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 flex items-center gap-2">
                    <Shield className="w-4 h-4 text-blue-600" />
                    <span className="text-sm text-blue-700">Plate and owner NIN will be verified with FRSC/NIMC after submission.</span>
                  </div>
                </div>

                <div className="flex justify-between pt-4">
                  <Button variant="outline" onClick={() => setStep(3)} className="gap-2"><ArrowLeft className="w-4 h-4" />Back</Button>
                  <div className="flex flex-col items-end gap-1.5">
                    <Button onClick={handleSubmit} className="bg-emerald-600 hover:bg-emerald-700 gap-2" disabled={registerVehicle.isPending || isReplaying}>
                      {registerVehicle.isPending || isReplaying ? <><Loader2 className="w-4 h-4 animate-spin" />{isReplaying ? "Syncing..." : "Submitting..."}</> : <>Submit Registration <CheckCircle2 className="w-4 h-4" /></>}
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
