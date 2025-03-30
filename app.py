from flask import Flask, request, jsonify, render_template_string import sqlite3 import hashlib import time import threading

app = Flask(name)

def init_db(): conn = sqlite3.connect('groups.db') cursor = conn.cursor() cursor.execute(''' CREATE TABLE IF NOT EXISTS locked_groups ( group_uid TEXT PRIMARY KEY, admin_uid TEXT NOT NULL, admin_token TEXT NOT NULL, original_name TEXT NOT NULL ) ''') conn.commit() conn.close()

init_db()

def hash_token(token): return hashlib.sha256(token.encode()).hexdigest()

def check_group_name(): while True: conn = sqlite3.connect('groups.db') cursor = conn.cursor() cursor.execute('SELECT group_uid, original_name FROM locked_groups') groups = cursor.fetchall() conn.close()

for group_uid, original_name in groups:
        current_name = get_group_name(group_uid)  # Fetch from API
        if current_name != original_name:
            set_group_name(group_uid, original_name)  # Reset Name
    
    time.sleep(300)  # Check every 5 minutes

def get_group_name(group_uid): # Implement API call to fetch group name return "Dummy Name"  # Replace with actual logic

def set_group_name(group_uid, name): # Implement API call to set group name pass

threading.Thread(target=check_group_name, daemon=True).start()

@app.route('/', methods=['GET']) def index(): return render_template_string(''' <html> <head> <title>Group Name Lock</title> <style> body { background: linear-gradient(45deg, #ff6b6b, #f7a6b1); color: white; font-family: Arial, sans-serif; text-align: center; padding: 20px; } input, button { margin: 10px; padding: 10px; font-size: 16px; border-radius: 5px; } button { cursor: pointer; background: #333; color: white; } </style> </head> <body> <h1>Group Name Lock System</h1> <form action="/lock" method="POST"> <input type="text" name="admin_uid" placeholder="Admin UID" required><br> <input type="password" name="admin_token" placeholder="Admin Token" required><br> <input type="text" name="group_uid" placeholder="Group UID" required><br> <input type="text" name="original_name" placeholder="Original Group Name" required><br> <button type="submit">Lock Group Name</button> </form> </body> </html> ''')

@app.route('/lock', methods=['POST']) def lock_group(): admin_uid = request.form.get('admin_uid') admin_token = hash_token(request.form.get('admin_token')) group_uid = request.form.get('group_uid') original_name = request.form.get('original_name')

conn = sqlite3.connect('groups.db')
cursor = conn.cursor()
cursor.execute('SELECT * FROM locked_groups WHERE group_uid = ?', (group_uid,))
if cursor.fetchone():
    conn.close()
    return jsonify({"status": "error", "message": "Group name already locked."})

cursor.execute('INSERT INTO locked_groups (group_uid, admin_uid, admin_token, original_name) VALUES (?, ?, ?, ?)',
               (group_uid, admin_uid, admin_token, original_name))
conn.commit()
conn.close()
return jsonify({"status": "success", "message": f"Group name locked successfully."})

if __name__ == '__main__':
    from waitress import serve  # Better than Flask's built-in server
    serve(app, host="0.0.0.0", port=5000)

