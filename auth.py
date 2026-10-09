"""
Authentication for the NMS dashboard.

Passwords are never stored in plain text: only salted SHA-256 hashes are kept here.
To add a user:  python -c "import auth; print(auth.hash_password('newpass'))"
"""
import hashlib
import hmac

SALT = "nms-22CSPW0"

# username -> {hash, role, full name}
USERS = {
    "admin": {
        "hash": "dc41b453e618b29dab8c72a56db32dd4f924340bc6dada2a7f143999fe017b85",
        "role": "Network Administrator",
        "name": "NMS Administrator",
    },
}


def hash_password(password: str) -> str:
    return hashlib.sha256(f"{SALT}:{password}".encode()).hexdigest()


def verify(username: str, password: str):
    """Returns the user record if the credentials are valid, else None."""
    user = USERS.get(username.strip().lower())
    if user and hmac.compare_digest(user["hash"], hash_password(password)):
        return {"username": username.strip().lower(), **user}
    return None
