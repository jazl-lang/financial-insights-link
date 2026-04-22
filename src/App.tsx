import { useState } from "react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import NotFound from "./pages/NotFound.tsx";
import LoginPage from "./components/LoginPage.tsx";

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function clearStorage(key: string): void {
  try { localStorage.removeItem(key); } catch { /* Safari private mode */ }
}

const App = () => {
  const [isAuthenticated, setIsAuthenticated] = useState(
    readStorage("pnl_auth") === "true"
  );

  if (!isAuthenticated) {
    return <LoginPage onLogin={() => setIsAuthenticated(true)} />;
  }

  const handleLogout = () => {
    clearStorage("pnl_auth");
    setIsAuthenticated(false);
  };

  return (
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter>
        <div className="relative">
          <button
            onClick={handleLogout}
            className="fixed top-4 right-4 z-50 bg-white border border-gray-200 text-gray-600 hover:text-red-500 hover:border-red-300 text-sm px-4 py-2 rounded-lg shadow-sm transition-colors"
          >
            Sign Out
          </button>
          <Routes>
            <Route path="/" element={<Index />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </div>
      </BrowserRouter>
    </TooltipProvider>
  );
};

export default App;
