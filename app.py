from flask import Flask, request, jsonify, render_template_string
import sqlite3
import hashlib
from waitress import serve
import threading
import time

app = Flask(name)

def init_db(): conn = sqlite3.connect('groups.db') cursor = conn.cursor() cursor.execute(''' CREATE TABLE IF NOT EXISTS locked_groups ( group_uid TEXT PRIMARY KEY, admin_uid TEXT NOT NULL, admin_token TEXT NOT NULL, group_name TEXT NOT NULL ) ''') conn.commit() conn.close()

init_db()

def hash_token(token): return hashlib.sha256(token.encode()).hexdigest()

@app.route('/', methods=['GET']) def index(): return render_template_string(''' <html> <head> <title>Group Name Lock System</title> </head> <body> <h1>Group Name Lock System</h1> <form action="/lock" method="POST"> <input type="text" name="admin_uid" placeholder="Admin UID" required><br> <input type="password" name="admin_token" placeholder="Admin Token" required><br> <input type="text" name="group_uid" placeholder="Group UID" required><br> <input type="text" name="group_name" placeholder="Group Name" required><br> <button type="submit">Lock Group Name</button> </form> <form action="/unlock" method="POST"> <input type="text" name="admin_uid" placeholder="Admin UID" required><br> <input type="password" name="admin_token" placeholder="Admin Token" required><br> <input type="text" name="group_uid" placeholder="Group UID" required><br> <button type="submit">Unlock Group Name</button> </form> </body> </html> ''')

@app.route('/lock', methods=['POST']) def lock_group_name(): admin_uid = request.form.get('admin_uid') admin_token = hash_token(request.form.get('admin_token')) group_uid = request.form.get('group_uid') group_name = request.form.get('group_name')

conn = sqlite3.connect('groups.db')
cursor = conn.cursor()
cursor.execute('SELECT * FROM locked_groups WHERE group_uid = ?', (group_uid,))
if cursor.fetchone():
    conn.close()
    return jsonify({"status": "error", "message": "Group name already locked."})

cursor.execute('INSERT INTO locked_groups (group_uid, admin_uid, admin_token, group_name) VALUES (?, ?, ?, ?)',
               (group_uid, admin_uid, admin_token, group_name))
conn.commit()
conn.close()
return jsonify({"status": "success", "message": f"Group name locked as {group_name}."})

@app.route('/unlock', methods=['POST']) def unlock_group_name(): admin_uid = request.form.get('admin_uid') admin_token = hash_token(request.form.get('admin_token')) group_uid = request.form.get('group_uid')

conn = sqlite3.connect('groups.db')
cursor = conn.cursor()
cursor.execute('SELECT admin_token FROM locked_groups WHERE group_uid = ?', (group_uid,))
result = cursor.fetchone()

if not result:
    conn.close()
    return jsonify({"status": "error", "message": "Group is not locked."})

stored_token = result[0]
if stored_token == admin_token:
    cursor.execute('DELETE FROM locked_groups WHERE group_uid = ?', (group_uid,))
    conn.commit()
    conn.close()
    return jsonify({"status": "success", "message": f"Group {group_uid} unlocked successfully."})
else:
    conn.close()
    return jsonify({"status": "error", "message": "Unauthorized: Invalid token or UID."})

def reset_group_names(): while True: conn = sqlite3.connect('groups.db') cursor = conn.cursor() cursor.execute('SELECT group_uid, group_name FROM locked_groups') locked_groups = cursor.fetchall() conn.close()

for group_uid, group_name in locked_groups:
        print(f"Resetting group {group_uid} name to {group_name}")
    
    time.sleep(300)  # Run every 5 minutes

if name == 'main': threading.Thread(target=reset_group_names, daemon=True).start() serve(app, host='0.0.0.0', port=5000)

