/**
 * NFC Batch Provisioning Page
 * ============================
 * Admin-only page for provisioning multiple NFC tags in bulk.
 * Operators upload a CSV of (tagId, vehicleRef) pairs; the server
 * derives per-tag HKDF keys and returns a downloadable results CSV.
 */
import { useState, useRef } from "react";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { toast } from "sonner";

const SAMPLE_CSV = `tagId,vehicleRef
NFC-001-ABCD,VEH-LAG001
NFC-002-EFGH,VEH-LAG002
NFC-003-IJKL,VEH-ABJ003`;

interface BatchResult {
  tagId: string;
  vehicleRef: string;
  refId?: string;
  keyHexPrefix?: string;
  signature?: string;
  status: string;
  error?: string;
}

export default function NfcBatchProvision() {
  const { user } = useAuth();
  const [csvContent, setCsvContent] = useState("");
  const [lastResult, setLastResult] = useState<{
    jobRef: string;
    totalTags: number;
    provisioned: number;
    failed: number;
    durationMs: number;
    status: string;
    csvOutput: string;
    results: BatchResult[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const submitBatch = trpc.nfcBatch.submitBatch.useMutation({
    onSuccess: (data) => {
      setLastResult(data);
      toast.success("Batch provisioning complete", {
        description: `${data.provisioned} tags provisioned, ${data.failed} failed in ${data.durationMs}ms`,
      });
    },
    onError: (err) => {
      toast.error("Batch provisioning failed", { description: err.message });
    },
  });

  const { data: jobs, refetch: refetchJobs } = trpc.nfcBatch.listJobs.useQuery();

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!file.name.endsWith(".csv")) {
      toast.error("Invalid file", { description: "Please upload a .csv file" });
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      setCsvContent(ev.target?.result as string ?? "");
    };
    reader.readAsText(file);
  };

  const handleSubmit = () => {
    if (!csvContent.trim()) {
      toast.error("No CSV content", { description: "Please paste or upload a CSV file" });
      return;
    }
    submitBatch.mutate({ csvContent });
  };

  const handleDownload = () => {
    if (!lastResult) return;
    const blob = new Blob([lastResult.csvOutput], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nfc-batch-${lastResult.jobRef}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (user?.role !== "admin") {
    return (
      <div className="container py-12">
        <Alert variant="destructive">
          <AlertDescription>Access denied. This page is restricted to administrators.</AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="container py-8 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">NFC Batch Provisioning</h1>
        <p className="text-muted-foreground mt-1">
          Upload a CSV of tag IDs and vehicle references to provision up to 500 NFC tags at once.
          The server derives per-tag HKDF-SHA256 keys and returns a results CSV for writing to physical tags.
        </p>
      </div>

      {/* Upload Panel */}
      <Card>
        <CardHeader>
          <CardTitle>Upload Batch CSV</CardTitle>
          <CardDescription>
            Required columns: <code className="text-xs bg-muted px-1 py-0.5 rounded">tagId</code>,{" "}
            <code className="text-xs bg-muted px-1 py-0.5 rounded">vehicleRef</code>. Maximum 500 rows per batch.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              Upload CSV File
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setCsvContent(SAMPLE_CSV)}
            >
              Load Sample
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv"
              className="hidden"
              onChange={handleFileUpload}
            />
          </div>

          <Textarea
            placeholder={SAMPLE_CSV}
            value={csvContent}
            onChange={(e) => setCsvContent(e.target.value)}
            rows={8}
            className="font-mono text-sm"
          />

          <div className="flex items-center gap-3">
            <Button
              onClick={handleSubmit}
              disabled={submitBatch.isPending || !csvContent.trim()}
            >
              {submitBatch.isPending ? "Provisioning…" : "Provision Tags"}
            </Button>
            {csvContent && (
              <span className="text-sm text-muted-foreground">
                {csvContent.trim().split("\n").length - 1} data rows detected
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Results Panel */}
      {lastResult && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <div>
                <CardTitle>Batch Results — {lastResult.jobRef}</CardTitle>
                <CardDescription>
                  {lastResult.provisioned} provisioned · {lastResult.failed} failed · {lastResult.durationMs}ms
                </CardDescription>
              </div>
              <div className="flex gap-2">
                <Badge variant={lastResult.failed === 0 ? "default" : lastResult.provisioned === 0 ? "destructive" : "secondary"}>
                  {lastResult.status}
                </Badge>
                <Button size="sm" onClick={handleDownload}>
                  Download CSV
                </Button>
              </div>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4">Tag ID</th>
                    <th className="text-left py-2 pr-4">Vehicle Ref</th>
                    <th className="text-left py-2 pr-4">Ref ID</th>
                    <th className="text-left py-2 pr-4">Key (prefix)</th>
                    <th className="text-left py-2 pr-4">Signature</th>
                    <th className="text-left py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {lastResult.results.map((r, i) => (
                    <tr key={i} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{r.tagId}</td>
                      <td className="py-2 pr-4">{r.vehicleRef}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.refId ?? "—"}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.keyHexPrefix ?? "—"}</td>
                      <td className="py-2 pr-4 font-mono text-xs">{r.signature ?? "—"}</td>
                      <td className="py-2">
                        {r.status === "ok" ? (
                          <Badge variant="default" className="text-xs">OK</Badge>
                        ) : (
                          <Badge variant="destructive" className="text-xs" title={r.error}>Error</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Job History */}
      {jobs && jobs.length > 0 && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Recent Batch Jobs</CardTitle>
              <Button variant="ghost" size="sm" onClick={() => refetchJobs()}>Refresh</Button>
            </div>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-muted-foreground">
                    <th className="text-left py-2 pr-4">Job Ref</th>
                    <th className="text-left py-2 pr-4">Total</th>
                    <th className="text-left py-2 pr-4">OK</th>
                    <th className="text-left py-2 pr-4">Failed</th>
                    <th className="text-left py-2 pr-4">Duration</th>
                    <th className="text-left py-2 pr-4">Status</th>
                    <th className="text-left py-2">Submitted</th>
                  </tr>
                </thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} className="border-b last:border-0">
                      <td className="py-2 pr-4 font-mono text-xs">{job.jobRef}</td>
                      <td className="py-2 pr-4">{job.totalTags}</td>
                      <td className="py-2 pr-4 text-green-600">{job.provisioned}</td>
                      <td className="py-2 pr-4 text-red-500">{job.failed}</td>
                      <td className="py-2 pr-4">{job.durationMs}ms</td>
                      <td className="py-2 pr-4">
                        <Badge
                          variant={job.status === "completed" ? "default" : job.status === "failed" ? "destructive" : "secondary"}
                          className="text-xs"
                        >
                          {job.status}
                        </Badge>
                      </td>
                      <td className="py-2 text-muted-foreground text-xs">
                        {new Date(job.createdAt).toLocaleString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
