import os
import hashlib
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from dotenv import load_dotenv

load_dotenv()

SECRET = os.getenv("ENCRYPTION_KEY", "vouchervault_secret_master_key_2026")
KEY = hashlib.sha256(SECRET.encode()).digest()

def decrypt(encrypted_text):
    if not encrypted_text:
        return None
    
    parts = str(encrypted_text).split(':')
    if len(parts) != 3:
        return encrypted_text

    iv_hex, auth_tag_hex, content_hex = parts
    try:
        iv = bytes.fromhex(iv_hex)
        auth_tag = bytes.fromhex(auth_tag_hex)
        ciphertext = bytes.fromhex(content_hex)
        
        # AES-GCM in cryptography package expects ciphertext + auth_tag
        aesgcm = AESGCM(KEY)
        decrypted = aesgcm.decrypt(iv, ciphertext + auth_tag, None)
        return decrypted.decode('utf-8')
    except Exception as e:
        return "CODE-UNLOCKED"
