import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ConfirmProvider, useConfirm } from "../src/ui/ConfirmDialog";

function Harness({ onResult }: { onResult: (v: boolean) => void }) {
  const confirm = useConfirm();
  return (
    <button
      type="button"
      onClick={() => {
        void confirm({
          title: "Delete?",
          body: "Sure? This cannot be undone.",
          confirmLabel: "Delete",
          danger: true
        }).then(onResult);
      }}
    >
      ask
    </button>
  );
}

describe("ConfirmDialog", () => {
  it("resolves true on confirm and false on cancel", async () => {
    const user = userEvent.setup();
    const results: boolean[] = [];
    render(
      <ConfirmProvider>
        <Harness onResult={(v) => results.push(v)} />
      </ConfirmProvider>
    );

    await user.click(screen.getByText("ask"));
    expect(screen.getByRole("dialog", { name: "Delete?" })).toBeInTheDocument();
    // Focus starts on Cancel so Enter can never confirm by accident.
    expect(screen.getByText("Cancel")).toHaveFocus();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(results).toEqual([false]);

    await user.click(screen.getByText("ask"));
    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(results).toEqual([false, true]);
  });
});
