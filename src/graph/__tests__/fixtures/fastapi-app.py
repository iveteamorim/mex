from fastapi import APIRouter, FastAPI

app = FastAPI()
router = APIRouter()
admin: APIRouter = APIRouter(prefix="/admin")


@app.get("/health")
def health():
    """Liveness probe.

    Documented like this elsewhere:
        @app.get("/not-a-route")
    """
    return {"status": "ok"}


@app.post("/users/{user_id}")
@app.patch("/users/{user_id}")
async def update_user(user_id: str):
    return {"user_id": user_id}


@router.put("/users/{user_id}")
def replace_user(user_id: str):
    return {"user_id": user_id}


@router.options("/users")
@router.head("/users")
def inspect_users():
    return None


@router.get(
    "/reports/{report_id}",
    response_model=None,
    status_code=200,
)
# a comment between a decorator and its def is legal
def read_report(report_id: str):
    return {"report_id": report_id}


@app.api_route("/legacy", methods=["GET", "POST"])
def legacy():
    return None


@app.get("/files/{file_path:path}")
def read_file(file_path: str):
    return {"path": file_path}


class AdminRoutes:
    @admin.delete("/users/{user_id}")
    def delete_user(self, user_id: str):
        return {"deleted": user_id}
