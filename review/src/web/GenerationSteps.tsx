export function GenerationSteps({ step, firstStep }: { step: 1 | 2; firstStep: string }) {
  return (
    <ol
      aria-label="Generation Steps"
      className="mx-4 mb-6 flex gap-6 border-b border-border py-4 text-xs sm:mx-6"
    >
      {[firstStep, "Configure Generation"].map((label, index) => (
        <li
          key={label}
          className={step === index + 1 ? "text-brand" : "text-muted-foreground"}
          aria-current={step === index + 1 ? "step" : undefined}
        >
          {index + 1}. {label}
        </li>
      ))}
    </ol>
  );
}
