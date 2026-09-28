/**
 * NigerianPass USSD Simulator — *346#
 * Design: Premium Civic — Navy authority base, Sora + Nunito Sans
 *
 * Emulates the full *346# USSD session flow:
 *   1. Check Balance
 *   2. Top Up Wallet
 *   3. Mini Statement (last 5 transactions)
 *   4. Register Vehicle
 *   5. Application Status
 *   0. Exit
 *
 * Renders as a GSM feature-phone screen with keypad input.
 * Fully state-machine driven — no external API calls needed.
 */
import { useState, useRef, useEffect, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Phone, Delete, RotateCcw, ChevronLeft, Smartphone, Wifi, WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";
import PortalLayout from "@/components/PortalLayout";
import { trpc } from "@/lib/trpc";
import { useAuth } from "@/_core/hooks/useAuth";
import { nanoid } from "nanoid";

// ── USSD state machine ────────────────────────────────────────────────────────
type ScreenId =
  | "idle"
  | "main_menu"
  | "check_balance"
  | "topup_menu"
  | "topup_amount"
  | "topup_confirm"
  | "topup_success"
  | "mini_statement"
  | "register_vehicle"
  | "register_plate"
  | "register_confirm"
  | "register_success"
  | "app_status"
  | "app_status_result"
  | "invalid_option"
  | "session_end";

interface Screen {
  id: ScreenId;
  text: string;
  options?: { key: string; label: string; next: ScreenId }[];
  inputPrompt?: string;
  inputNext?: (val: string) => ScreenId;
  isEnd?: boolean;
}

// Demo state
const DEMO_BALANCE = 4_650;
const DEMO_TRANSACTIONS = [
  { date: "06/03", desc: "Lagos-Ibadan Toll", amount: -350 },
  { date: "05/03", desc: "Wallet Top-Up", amount: 5000 },
  { date: "05/03", desc: "Berger Toll Plaza", amount: -350 },
  { date: "04/03", desc: "Sagamu Interchange", amount: -350 },
  { date: "03/03", desc: "Wallet Top-Up", amount: 2000 },
];

const SCREENS: Record<ScreenId, Screen> = {
  idle: {
    id: "idle",
    text: "Dial *346# to start",
  },
  main_menu: {
    id: "main_menu",
    text: "NigerianPass\nWelcome!\n\n1. Check Balance\n2. Top Up Wallet\n3. Mini Statement\n4. Register Vehicle\n5. App Status\n0. Exit",
    options: [
      { key: "1", label: "Check Balance", next: "check_balance" },
      { key: "2", label: "Top Up Wallet", next: "topup_menu" },
      { key: "3", label: "Mini Statement", next: "mini_statement" },
      { key: "4", label: "Register Vehicle", next: "register_vehicle" },
      { key: "5", label: "App Status", next: "app_status" },
      { key: "0", label: "Exit", next: "session_end" },
    ],
  },
  check_balance: {
    id: "check_balance",
    text: `NigerianPass\nWallet Balance:\n\nAvailable: ₦${DEMO_BALANCE.toLocaleString()}\nFare Cap Today: ₦350/₦700\n\nLast Toll: Lagos-Ibadan\n₦350 on 06/03/2026\n\n0. Back to Menu`,
    options: [{ key: "0", label: "Back", next: "main_menu" }],
  },
  topup_menu: {
    id: "topup_menu",
    text: "NigerianPass\nTop Up Wallet\n\n1. ₦500\n2. ₦1,000\n3. ₦2,000\n4. ₦5,000\n5. Other Amount\n0. Back",
    options: [
      { key: "1", label: "₦500", next: "topup_confirm" },
      { key: "2", label: "₦1,000", next: "topup_confirm" },
      { key: "3", label: "₦2,000", next: "topup_confirm" },
      { key: "4", label: "₦5,000", next: "topup_confirm" },
      { key: "5", label: "Other Amount", next: "topup_amount" },
      { key: "0", label: "Back", next: "main_menu" },
    ],
  },
  topup_amount: {
    id: "topup_amount",
    text: "NigerianPass\nEnter Amount:\n\nMin: ₦100\nMax: ₦50,000\n\nEnter amount and\npress Send:",
    inputPrompt: "Enter amount (₦)",
    inputNext: (val) => {
      const n = parseInt(val.replace(/\D/g, ""), 10);
      if (!isNaN(n) && n >= 100 && n <= 50000) return "topup_confirm";
      return "invalid_option";
    },
  },
  topup_confirm: {
    id: "topup_confirm",
    text: "NigerianPass\nConfirm Top-Up\n\nAmount: ₦1,000\nMethod: Airtime Deduction\nPhone: 0801****678\n\n1. Confirm\n2. Cancel",
    options: [
      { key: "1", label: "Confirm", next: "topup_success" },
      { key: "2", label: "Cancel", next: "main_menu" },
    ],
  },
  topup_success: {
    id: "topup_success",
    text: "NigerianPass\nTop-Up Successful!\n\nAmount Added: ₦1,000\nNew Balance: ₦5,650\n\nRef: TXN-9921-USSD\n\nThank you for using\nNigerianPass.\n\n0. Main Menu",
    options: [{ key: "0", label: "Main Menu", next: "main_menu" }],
  },
  mini_statement: {
    id: "mini_statement",
    text: `NigerianPass\nLast 5 Transactions:\n\n${DEMO_TRANSACTIONS.map(t =>
      `${t.date} ${t.amount > 0 ? "+" : ""}₦${Math.abs(t.amount).toLocaleString()} ${t.desc.slice(0, 12)}`
    ).join("\n")}\n\n0. Back to Menu`,
    options: [{ key: "0", label: "Back", next: "main_menu" }],
  },
  register_vehicle: {
    id: "register_vehicle",
    text: "NigerianPass\nRegister Vehicle\n\nEnter plate number\n(e.g. LG234ABC):\n\nPress Send when done:",
    inputPrompt: "Enter plate number",
    inputNext: (val) => val.length >= 6 ? "register_confirm" : "invalid_option",
  },
  register_plate: {
    id: "register_plate",
    text: "NigerianPass\nEnter Plate Number:\n\nFormat: LG234ABC\n\nPress Send:",
    inputPrompt: "Plate number",
    inputNext: (val) => val.length >= 6 ? "register_confirm" : "invalid_option",
  },
  register_confirm: {
    id: "register_confirm",
    text: "NigerianPass\nConfirm Vehicle\n\nPlate: LG-234-ABC\nState: Lagos\nClass: Category 1\n\n1. Confirm\n2. Cancel",
    options: [
      { key: "1", label: "Confirm", next: "register_success" },
      { key: "2", label: "Cancel", next: "main_menu" },
    ],
  },
  register_success: {
    id: "register_success",
    text: "NigerianPass\nVehicle Submitted!\n\nRef: VEH-USSD-7821\nStatus: Pending Review\n\nYou will receive an\nSMS when approved.\n\n0. Main Menu",
    options: [{ key: "0", label: "Main Menu", next: "main_menu" }],
  },
  app_status: {
    id: "app_status",
    text: "NigerianPass\nApplication Status\n\nEnter reference\nnumber:\n(e.g. DRV-XKQP7)\n\nPress Send:",
    inputPrompt: "Enter reference",
    inputNext: (val) => val.trim().length >= 6 ? "app_status_result" : "invalid_option",
  },
  app_status_result: {
    id: "app_status_result",
    text: "NigerianPass\nApp Status:\n\nRef: DRV-XKQP7\nName: C. Okonkwo\nStatus: Under Review\nScore: 87/100\n\nExpected: 1-2 days\nSMS alert on update.\n\n0. Main Menu",
    options: [{ key: "0", label: "Main Menu", next: "main_menu" }],
  },
  invalid_option: {
    id: "invalid_option",
    text: "NigerianPass\nInvalid option.\nPlease try again.\n\n0. Back to Menu",
    options: [{ key: "0", label: "Back", next: "main_menu" }],
  },
  session_end: {
    id: "session_end",
    text: "NigerianPass\nSession ended.\n\nThank you for using\nNigerianPass.\n\nDial *346# to start\na new session.",
    isEnd: true,
  },
};

// ── Keypad layout ─────────────────────────────────────────────────────────────
const KEYPAD = [
  ["1", "2", "3"],
  ["4", "5", "6"],
  ["7", "8", "9"],
  ["*", "0", "#"],
];

// ── Phone screen component ────────────────────────────────────────────────────
function PhoneScreen({ text, isIdle }: { text: string; isIdle: boolean }) {
  return (
    <div className={cn(
      "font-mono text-sm leading-relaxed whitespace-pre-wrap min-h-36",
      isIdle ? "text-muted-foreground" : "text-foreground"
    )}>
      {text}
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────
export default function UssdSimulator() {
  const { user } = useAuth();
  const [currentScreen, setCurrentScreen] = useState<ScreenId>("idle");
  const [inputValue, setInputValue] = useState("");
  const [dialInput, setDialInput] = useState("");
  const [sessionLog, setSessionLog] = useState<{ screen: string; input?: string }[]>([]);
  const [isDialing, setIsDialing] = useState(false);
  const [topupAmount, setTopupAmount] = useState(1000);
  const [vehiclePlate, setVehiclePlate] = useState("LG-234-ABC");
  const [appRef, setAppRef] = useState("DRV-XKQP7");
  const screenRef = useRef<HTMLDivElement>(null);

  // Live backend mode
  const [liveMode, setLiveMode] = useState(false);
  const [liveSessionId] = useState(() => nanoid());
  const [liveText, setLiveText] = useState("");
  const [liveIsEnd, setLiveIsEnd] = useState(false);
  const [liveInputChain, setLiveInputChain] = useState(""); // accumulated *-separated inputs
  const [liveLoading, setLiveLoading] = useState(false);

  const ussdSession = trpc.ussd.session.useMutation();

  const sendLiveInput = useCallback(async (input: string) => {
    setLiveLoading(true);
    const newChain = liveInputChain ? `${liveInputChain}*${input}` : input;
    setLiveInputChain(newChain);
    try {
      const result = await ussdSession.mutateAsync({
        sessionId: liveSessionId,
        phoneNumber: user?.email ?? "0800000000",
        text: newChain,
        userId: user?.id?.toString(),
      });
      setLiveText(result.text);
      setLiveIsEnd(!result.isContinue);
      if (!result.isContinue) setLiveInputChain("");
    } catch (e) {
      setLiveText("Error connecting to server.\nPlease try again.");
      setLiveIsEnd(true);
    } finally {
      setLiveLoading(false);
    }
  }, [liveInputChain, liveSessionId, user, ussdSession]);

  const resetLive = () => {
    setLiveText("");
    setLiveIsEnd(false);
    setLiveInputChain("");
  };

  const screen = SCREENS[currentScreen];

  // Auto-scroll screen text
  useEffect(() => {
    screenRef.current?.scrollTo({ top: screenRef.current.scrollHeight, behavior: "smooth" });
  }, [currentScreen]);

  const getScreenText = (id: ScreenId): string => {
    const s = SCREENS[id];
    if (id === "topup_confirm") {
      return `NigerianPass\nConfirm Top-Up\n\nAmount: ₦${topupAmount.toLocaleString()}\nMethod: Airtime Deduction\nPhone: 0801****678\n\n1. Confirm\n2. Cancel`;
    }
    if (id === "register_confirm") {
      return `NigerianPass\nConfirm Vehicle\n\nPlate: ${vehiclePlate.toUpperCase()}\nState: Lagos\nClass: Category 1\n\n1. Confirm\n2. Cancel`;
    }
    if (id === "app_status_result") {
      const ref = appRef.toUpperCase();
      const isKnown = ref === "DRV-XKQP7";
      return isKnown
        ? `NigerianPass\nApp Status:\n\nRef: ${ref}\nName: C. Okonkwo\nStatus: Under Review\nScore: 87/100\n\nExpected: 1-2 days\nSMS alert on update.\n\n0. Main Menu`
        : `NigerianPass\nApp Status:\n\nRef: ${ref}\nStatus: Not Found\n\nCheck reference and\ntry again.\n\n0. Main Menu`;
    }
    return s.text;
  };

  const handleDial = () => {
    if (dialInput === "*346#") {
      setIsDialing(false);
      setDialInput("");
      if (liveMode) {
        // Send empty text to get main menu from backend
        sendLiveInput("");
      } else {
        setCurrentScreen("main_menu");
        setSessionLog([{ screen: "main_menu" }]);
      }
    }
  };

  const handleKeypadPress = (key: string) => {
    if (liveMode) {
      // In live mode: accumulate input or send single-key choices
      if (currentScreen === "idle" || isDialing) {
        setIsDialing(true);
        setDialInput(prev => prev + key);
        if (key === "#" && dialInput + key === "*346#") {
          setIsDialing(false);
          setDialInput("");
          setCurrentScreen("main_menu"); // just for state tracking
          sendLiveInput("");
        }
        return;
      }
      if (liveIsEnd) return; // session ended
      // Single-digit menu choices go immediately
      if (/^[0-9]$/.test(key) && !inputValue) {
        sendLiveInput(key);
      } else {
        setInputValue(prev => prev + key);
      }
      return;
    }
    // Demo mode
    if (currentScreen === "idle") {
      setIsDialing(true);
      setDialInput(prev => prev + key);
      return;
    }
    if (isDialing) {
      if (key === "#") {
        setDialInput(prev => prev + key);
        handleDial();
      } else {
        setDialInput(prev => prev + key);
      }
      return;
    }
    if (screen.inputPrompt) {
      setInputValue(prev => prev + key);
    } else if (screen.options) {
      const opt = screen.options.find(o => o.key === key);
      if (opt) {
        navigate(opt.next, key);
      }
    }
  };

  const handleBackspace = () => {
    if (isDialing) { setDialInput(prev => prev.slice(0, -1)); return; }
    if (screen.inputPrompt) setInputValue(prev => prev.slice(0, -1));
  };

  const handleSend = () => {
    if (liveMode) {
      if (isDialing) { handleDial(); return; }
      if (inputValue.trim()) {
        sendLiveInput(inputValue.trim());
        setInputValue("");
      }
      return;
    }
    if (isDialing) { handleDial(); return; }
    if (screen.inputPrompt && screen.inputNext) {
      // Capture context-specific values
      if (currentScreen === "topup_amount") {
        const n = parseInt(inputValue.replace(/\D/g, ""), 10);
        if (!isNaN(n) && n >= 100) setTopupAmount(n);
      }
      if (currentScreen === "register_vehicle" || currentScreen === "register_plate") {
        setVehiclePlate(inputValue.toUpperCase());
      }
      if (currentScreen === "app_status") {
        setAppRef(inputValue.toUpperCase());
      }
      const next = screen.inputNext(inputValue);
      navigate(next, inputValue);
      setInputValue("");
    }
  };

  const navigate = (next: ScreenId, input?: string) => {
    setSessionLog(prev => [...prev, { screen: next, input }]);
    setCurrentScreen(next);
  };

  const handleReset = () => {
    setCurrentScreen("idle");
    setInputValue("");
    setDialInput("");
    setIsDialing(false);
    setSessionLog([]);
    if (liveMode) resetLive();
  };

  const displayText = liveMode
    ? (isDialing
        ? `Dialing...\n\n${dialInput}`
        : liveLoading
        ? "Connecting...\n\nPlease wait."
        : liveText || "Ready\n\nDial *346# to access\nNigerianPass USSD\nservices.")
    : isDialing
    ? `Dialing...\n\n${dialInput}`
    : currentScreen === "idle"
    ? "Ready\n\nDial *346# to access\nNigerianPass USSD\nservices."
    : getScreenText(currentScreen);

  return (
    <PortalLayout title="USSD Simulator" subtitle="Preview the *346# NigerianPass USSD experience for feature phones">
      <div className="max-w-5xl mx-auto p-4 md:p-6 lg:p-8">

        {/* Explainer + Live toggle */}
        <div className="mb-6 p-4 bg-blue-50 border border-blue-200 rounded-xl flex items-start gap-3">
          <Smartphone className="w-5 h-5 text-blue-600 shrink-0 mt-0.5" />
          <div className="flex-1">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-blue-800">Feature Phone USSD Simulator</p>
              <button
                onClick={() => { setLiveMode(m => !m); resetLive(); handleReset(); }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-semibold border transition-colors",
                  liveMode
                    ? "bg-green-100 border-green-400 text-green-800"
                    : "bg-gray-100 border-gray-300 text-gray-600 hover:bg-gray-200"
                )}
              >
                {liveMode ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
                {liveMode ? "Live Backend" : "Demo Mode"}
              </button>
            </div>
            <p className="text-sm text-blue-700 mt-0.5">
              This simulator replicates the <code className="bg-blue-100 px-1 rounded">*346#</code> USSD session available on any GSM phone in Nigeria. Toggle <strong>Live Backend</strong> to route inputs through the real tRPC server.
            </p>
          </div>
        </div>

        <div className="grid md:grid-cols-2 gap-8 items-start">
          {/* ── Phone mockup ──────────────────────────────────────────────── */}
          <div className="flex justify-center">
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="relative"
              style={{ width: 280 }}
            >
              {/* Phone body */}
              <div className="bg-[#1a1a2e] rounded-[2.5rem] p-4 shadow-2xl border-4 border-[#2a2a4e]">
                {/* Speaker */}
                <div className="flex justify-center mb-3">
                  <div className="w-16 h-1.5 bg-[#2a2a4e] rounded-full" />
                </div>

                {/* Screen */}
                <div className="bg-[#c8e6c9] rounded-2xl p-4 min-h-56 relative overflow-hidden border-2 border-[#4caf50]/30">
                  {/* Screen glow */}
                  <div className="absolute inset-0 bg-gradient-to-b from-[#e8f5e9]/40 to-transparent pointer-events-none" />

                  {/* Status bar */}
                  <div className="flex items-center justify-between mb-3 text-[10px] text-[#2e7d32] font-mono">
                    <span>MTN NG ▐▐▐</span>
                    <span>*346#</span>
                    <span>12:34</span>
                  </div>

                  {/* Screen content */}
                  <div ref={screenRef} className="overflow-y-auto max-h-44">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={currentScreen}
                        initial={{ opacity: 0, y: 4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.15 }}
                        className="font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[#1b5e20]"
                      >
                        {displayText}
                      </motion.div>
                    </AnimatePresence>
                  </div>

                  {/* Input display */}
                  {(screen.inputPrompt || isDialing) && (
                    <div className="mt-2 border-t border-[#4caf50]/30 pt-2">
                      <div className="font-mono text-[11px] text-[#2e7d32]">
                        {isDialing ? dialInput : (inputValue || "_")}
                      </div>
                    </div>
                  )}
                </div>

                {/* Keypad */}
                <div className="mt-4 space-y-2">
                  {/* Send / End row */}
                  <div className="grid grid-cols-3 gap-2 mb-1">
                    <button
                      onClick={handleSend}
                      className="col-span-1 py-2 rounded-xl bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700 active:scale-95 transition-all"
                    >
                      SEND
                    </button>
                    <button
                      onClick={handleReset}
                      className="col-span-1 py-2 rounded-xl bg-red-600 text-white text-xs font-bold hover:bg-red-700 active:scale-95 transition-all"
                    >
                      END
                    </button>
                    <button
                      onClick={handleBackspace}
                      className="col-span-1 py-2 rounded-xl bg-[#2a2a4e] text-white text-xs hover:bg-[#3a3a6e] active:scale-95 transition-all flex items-center justify-center"
                    >
                      <Delete className="w-3.5 h-3.5" />
                    </button>
                  </div>

                  {KEYPAD.map((row, ri) => (
                    <div key={ri} className="grid grid-cols-3 gap-2">
                      {row.map(key => (
                        <button
                          key={key}
                          onClick={() => handleKeypadPress(key)}
                          className="py-3 rounded-xl bg-[#2a2a4e] text-white text-sm font-bold hover:bg-[#3a3a6e] active:scale-95 transition-all border border-[#3a3a6e]"
                        >
                          {key}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>

                {/* Home button */}
                <div className="flex justify-center mt-4">
                  <button
                    onClick={handleReset}
                    className="w-10 h-10 rounded-full bg-[#2a2a4e] border-2 border-[#3a3a6e] hover:bg-[#3a3a6e] transition-all flex items-center justify-center"
                  >
                    <RotateCcw className="w-4 h-4 text-white/60" />
                  </button>
                </div>
              </div>
            </motion.div>
          </div>

          {/* ── Right panel: instructions + session log ──────────────────── */}
          <div className="space-y-5">
            {/* Quick start */}
            <div className="bg-white rounded-2xl border border-border p-5 shadow-sm">
              <h3 className="font-bold mb-3" style={{ fontFamily: "Sora, sans-serif" }}>Quick Start</h3>
              <ol className="space-y-2">
                {[
                  { step: "1", text: "Press 3, 4, 6, # on the keypad to dial *346#" },
                  { step: "2", text: "Press SEND to initiate the session" },
                  { step: "3", text: "Press a menu number (1–5) then SEND to navigate" },
                  { step: "4", text: "For text input, type on the keypad then press SEND" },
                  { step: "5", text: "Press END or the reset button to start over" },
                ].map(item => (
                  <li key={item.step} className="flex items-start gap-2.5">
                    <span className="w-5 h-5 rounded-full bg-primary/10 text-primary text-xs font-bold flex items-center justify-center shrink-0 mt-0.5">
                      {item.step}
                    </span>
                    <span className="text-sm text-muted-foreground">{item.text}</span>
                  </li>
                ))}
              </ol>
            </div>

            {/* Menu tree */}
            <div className="bg-white rounded-2xl border border-border p-5 shadow-sm">
              <h3 className="font-bold mb-3" style={{ fontFamily: "Sora, sans-serif" }}>Menu Tree</h3>
              <div className="space-y-1.5 text-sm">
                {[
                  { code: "*346#", label: "Start session", depth: 0 },
                  { code: "1", label: "Check Balance", depth: 1 },
                  { code: "2", label: "Top Up Wallet → choose amount → confirm", depth: 1 },
                  { code: "3", label: "Mini Statement (last 5 transactions)", depth: 1 },
                  { code: "4", label: "Register Vehicle → enter plate → confirm", depth: 1 },
                  { code: "5", label: "App Status → enter reference number", depth: 1 },
                  { code: "0", label: "Exit session", depth: 1 },
                ].map(item => (
                  <div key={item.code} className={cn("flex items-center gap-2", item.depth > 0 && "ml-4")}>
                    {item.depth > 0 && <ChevronLeft className="w-3 h-3 text-muted-foreground rotate-180" />}
                    <code className="text-xs bg-muted px-1.5 py-0.5 rounded font-mono">{item.code}</code>
                    <span className="text-muted-foreground text-xs">{item.label}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Session log */}
            {sessionLog.length > 0 && (
              <div className="bg-white rounded-2xl border border-border p-5 shadow-sm">
                <h3 className="font-bold mb-3" style={{ fontFamily: "Sora, sans-serif" }}>Session Log</h3>
                <div className="space-y-1 max-h-40 overflow-y-auto">
                  {sessionLog.map((entry, i) => (
                    <div key={i} className="flex items-center gap-2 text-xs">
                      <span className="text-muted-foreground font-mono w-4">{i + 1}.</span>
                      <span className="font-medium text-foreground">{entry.screen.replace(/_/g, " ")}</span>
                      {entry.input && (
                        <span className="text-muted-foreground">← <code className="bg-muted px-1 rounded">{entry.input}</code></span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Keyboard shortcut hint */}
            <div className="p-3 bg-muted/50 rounded-xl border border-border">
              <p className="text-xs text-muted-foreground">
                <strong>Keyboard tip:</strong> You can also type digits directly on your keyboard. Press <kbd className="bg-white border border-border rounded px-1 text-[10px]">Enter</kbd> to send.
              </p>
            </div>
          </div>
        </div>
      </div>
    </PortalLayout>
  );
}
