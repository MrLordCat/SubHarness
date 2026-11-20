import { useCallback, useId, useState } from "preact/hooks";
import type { ChatQuestionRequest, ChatQuestionAnswer } from "../shared/protocol";

interface QuestionCardProps {
	request: ChatQuestionRequest;
	onAnswer: (id: string, answers: ChatQuestionAnswer[] | undefined) => void;
}

function initialSelection(request: ChatQuestionRequest): string[][] {
	return request.questions.map(question => {
		const recommended = (question.options ?? []).filter(option => option.recommended).map(option => option.label);
		return question.multiSelect === true ? recommended : recommended.slice(0, 1);
	});
}

export function QuestionCard({ request, onAnswer }: QuestionCardProps) {
	const instanceId = useId();
	const [selected, setSelected] = useState<string[][]>(() => initialSelection(request));
	const [freeform, setFreeform] = useState<string[]>(() => request.questions.map(() => ""));
	const [pending, setPending] = useState(false);

	const submit = useCallback(() => {
		setPending(true);
		const answers: ChatQuestionAnswer[] = request.questions.map((question, index) => {
			const text = freeform[index]?.trim() ?? "";
			return { header: question.header, selected: selected[index] ?? [], ...(text ? { freeform: text } : {}) };
		});
		onAnswer(request.id, answers);
	}, [freeform, onAnswer, request, selected]);

	const skip = useCallback(() => {
		setPending(true);
		onAnswer(request.id, undefined);
	}, [onAnswer, request.id]);

	const toggle = useCallback((index: number, label: string, multi: boolean) => {
		setSelected(current => current.map((labels, at) => {
			if (at !== index) {
				return labels;
			}
			if (!multi) {
				return [label];
			}
			return labels.includes(label) ? labels.filter(item => item !== label) : [...labels, label];
		}));
	}, []);

	const type = useCallback((index: number, value: string) => {
		setFreeform(current => current.map((text, at) => at === index ? value : text));
	}, []);

	return (
		<div class="approval-card question-card" role="group" aria-label="Questions from the agent">
			{request.questions.map((question, index) => {
				const options = question.options ?? [];
				const freeformAllowed = question.allowFreeformInput !== false;
				return (
					<fieldset class="question-fieldset" key={question.header}>
						<legend class="question-header">{question.header}</legend>
						<div class="question-text">{question.question}</div>
						{question.message ? <div class="question-message">{question.message}</div> : null}
						{options.length > 0 ? (
							<div class="question-options">
								{options.map(option => (
									<label class="question-option" key={option.label}>
										<input
											type={question.multiSelect === true ? "checkbox" : "radio"}
											name={`${instanceId}-${index}`}
											checked={(selected[index] ?? []).includes(option.label)}
											onChange={() => toggle(index, option.label, question.multiSelect === true)}
										/>
										<span class="question-option-body">
											<span class="question-option-label">
												{option.label}
												{option.recommended ? <span class="question-recommended">Recommended</span> : null}
											</span>
											{option.description ? <span class="question-option-description">{option.description}</span> : null}
										</span>
									</label>
								))}
							</div>
						) : null}
						{freeformAllowed ? (
							<textarea
								class="question-input"
								aria-label={`${question.header}: your answer`}
								rows={1}
								value={freeform[index] ?? ""}
								placeholder={options.length > 0 ? "Other answer…" : "Your answer…"}
								onInput={event => type(index, event.currentTarget.value)}
								onKeyDown={event => {
									if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
										event.preventDefault();
										submit();
									}
								}}
							/>
						) : null}
					</fieldset>
				);
			})}
			<div class="approval-actions">
				<button type="button" class="approval-allow" disabled={pending} onClick={submit}>Submit</button>
				<button type="button" class="approval-deny" disabled={pending} onClick={skip}>Skip</button>
			</div>
		</div>
	);
}
