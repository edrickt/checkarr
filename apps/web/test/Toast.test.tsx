import { describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ToastProvider, useToast } from "../src/ui/Toast";

type Toaster = { success: (t: string) => void; error: (t: string) => void };

function Harness({ fire }: { fire: (t: Toaster) => void }) {
  const toast = useToast();
  return (
    <button
      type="button"
      onClick={() => {
        fire(toast);
      }}
    >
      go
    </button>
  );
}

function renderHarness(fire: (t: Toaster) => void) {
  render(
    <ToastProvider>
      <Harness fire={fire} />
    </ToastProvider>
  );
}

describe("Toast", () => {
  it("marks successes as status and errors as alert", () => {
    renderHarness((t) => {
      t.success("Saved ok");
      t.error("Boom");
    });
    fireEvent.click(screen.getByText("go"));
    expect(screen.getByRole("status")).toHaveTextContent("Saved ok");
    expect(screen.getByRole("alert")).toHaveTextContent("Boom");
  });

  it("auto-dismisses successes but keeps errors until dismissed", async () => {
    vi.useFakeTimers();
    try {
      renderHarness((t) => {
        t.success("Saved ok");
        t.error("Boom");
      });
      fireEvent.click(screen.getByText("go"));
      // The dismiss timeout fires outside React's act(): flush the resulting
      // state update explicitly before asserting.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(6100);
      });
      expect(screen.queryByRole("status")).not.toBeInTheDocument();
      expect(screen.getByRole("alert")).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss notification" }));
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
