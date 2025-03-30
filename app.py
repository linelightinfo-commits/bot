from flask import Flask, request, jsonify, render_template_string import sqlite3 as sql import hashlib from waitress import serve import threading import time

app = Flask(name)

Database Setup

def init_db(): conn = sql.connect('groups.db') cursor = conn.cursor() cursor.execute(''' CREATE TABLE IF NOT EXISTS locked_groups ( group_uid TEXT PRIMARY KEY, admin_uid TEXT NOT NULL, admin_token TEXT NOT NULL, original_name TEXT NOT NULL ) ''') conn.commit() conn.close()

init_db()

Function to hash token (for security)

def hash_token(token): return hashlib.sha256(token.encode()).hexdigest()

@app.route('/', methods=['GET']) def index(): return render_template_string(''' <html> <head> <title>Group Name Lock System</title> <style> body { background: linear-gradient(45deg, #ff6b6b, #f7a6b1); color: white; font-family: Arial, sans-serif; text-align: center; padding: 20px; } input, button, select { margin: 10px; padding: 10px; font-size: 16px; border: none; border-radius: 5px; } button { cursor: pointer; background: #333; color: white; } </style> </head> <body> <h1>Group Name Lock System</h1> <form action="/lock" method="POST"> <input type="text" name="admin_uid" placeholder="Admin UID" required><br> <input type="password" name="admin_token" placeholder="Admin Token" required><br> <input type="text" name="group_uid" placeholder="Group UID" required><br> <input type="text" name="original_name" placeholder="Original Group Name" required><br> <button type="submit">Lock Group Name</button> </form> </body> </html> ''')

@app.route('/lock', methods=['POST']) def lock_group_name(): admin_uid = request.form.get('admin_uid') admin_token = hash_token(request.form.get('admin_token')) group_uid = request.form.get('group_uid') original_name = request.form.get('original_name')

conn = sql.connect('groups.db')
cursor = conn.cursor()
cursor.execute('SELECT * FROM locked_groups WHERE group_uid = ?', (group_uid,))
if cursor.fetchone():
    conn.close()
    return jsonify({"status": "error", "message": "Group name is already locked."})

cursor.execute('INSERT INTO locked_groups (group_uid, admin_uid, admin_token, original_name) VALUES (?, ?, ?, ?)',
               (group_uid, admin_uid, admin_token, original_name))
conn.commit()
conn.close()
return jsonify({"status": "success", "message": f"Group {group_uid} name locked successfully."})

Background Task to Monitor Group Name Changes

def monitor_group_names(): while True: time.sleep(300)  # Check every 5 minutes conn = sql.connect('groups.db') cursor = conn.cursor() cursor.execute('SELECT group_uid, original_name FROM locked_groups') locked_groups = cursor.fetchall() conn.close()

for group_uid, original_name in locked_groups:
        current_name = get_group_name(group_uid)
        if current_name and current_name != original_name:
            set_group_name(group_uid, original_name)
            print(f"Reset group name for {group_uid} to {original_name}")

def get_group_name(group_uid): # TODO: Implement API call to fetch group name return "Mocked Group Name"

def set_group_name(group_uid, name): # TODO: Implement API call to reset group name print(f"[Mock] Setting group {group_uid} name to {name}")

Start background monitoring thread

threading.Thread(target=monitor_group_names, daemon=True).start()

if name == 'main': serve(app, host='0.0.0.0', port=5000)

