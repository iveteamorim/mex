def load_project_terms(question: str) -> list[str]:
    return question.lower().split()


def answer_repository_question(question: str) -> list[str]:
    return load_project_terms(question)
