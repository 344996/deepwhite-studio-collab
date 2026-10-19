"""Create an external Ed25519 signing key or sign an update metadata document."""
import argparse
import base64
import json
import os
from pathlib import Path
import subprocess

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False).encode('utf-8')


def create_key(path, key_id):
    path = Path(path).resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    external_key_path(path)
    key = Ed25519PrivateKey.generate()
    data = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                             serialization.NoEncryption())
    with path.open('xb') as stream:
        stream.write(data)
        stream.flush()
        os.fsync(stream.fileno())
    if os.name == 'nt':
        identity = subprocess.check_output(['whoami'], text=True).strip()
        subprocess.run(['icacls', str(path), '/inheritance:r', '/grant:r', identity + ':(F)',
                        'SYSTEM:(F)'], check=True, capture_output=True)
    else:
        path.chmod(0o600)
    return {key_id: base64.b64encode(key.public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode('ascii')}


def external_key_path(path, forbidden_roots=()):
    path = Path(path).resolve()
    if any(path.is_relative_to(Path(root).resolve()) for root in forbidden_roots):
        raise ValueError('Private signing keys must be outside release output and build cache/staging.')
    check = subprocess.run(['git', '-C', str(path.parent), 'rev-parse', '--show-toplevel'],
                           capture_output=True, text=True)
    if check.returncode == 0:
        raise ValueError('Private signing keys must be outside every Git worktree.')
    return path


def load_key(path):
    key = serialization.load_pem_private_key(external_key_path(path).read_bytes(), password=None)
    if not isinstance(key, Ed25519PrivateKey):
        raise ValueError('Expected an Ed25519 private signing key.')
    return key


def public_key(path, key_id):
    return {key_id: base64.b64encode(load_key(path).public_key().public_bytes(
        serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode('ascii')}


def sign_manifest(signed, private_key, key_id):
    signature = load_key(private_key).sign(canonical(signed))
    return {'signed': signed, 'signatures': [{'key_id': key_id,
            'signature': base64.b64encode(signature).decode('ascii')}]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='action', required=True)
    create = commands.add_parser('create-key')
    create.add_argument('--private-key', type=Path, required=True)
    create.add_argument('--key-id', required=True)
    create.add_argument('--public-output', type=Path, required=True)
    sign = commands.add_parser('sign')
    sign.add_argument('--private-key', type=Path, required=True)
    sign.add_argument('--key-id', required=True)
    sign.add_argument('--input', type=Path, required=True)
    sign.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    if args.action == 'create-key':
        existing = {}
        if args.public_output.exists():
            existing = json.loads(args.public_output.read_text(encoding='utf-8'))
            if args.key_id in existing:
                raise ValueError('The public key ID already exists; existing keys were preserved.')
        trust = {**existing, **create_key(args.private_key, args.key_id)}
        args.public_output.parent.mkdir(parents=True, exist_ok=True)
        args.public_output.write_bytes(canonical(trust))
        print('Created private key outside Git and wrote public trust metadata.')
    else:
        external_key_path(args.private_key, (args.output.parent,))
        signed = json.loads(args.input.read_text(encoding='utf-8'))
        envelope = sign_manifest(signed, args.private_key, args.key_id)
        with args.output.open('xb') as stream:
            stream.write(canonical(envelope))
        print('Signed update metadata:', args.output)


if __name__ == '__main__':
    main()
