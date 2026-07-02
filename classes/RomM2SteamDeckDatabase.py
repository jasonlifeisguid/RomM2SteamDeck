import sqlite3
import threading
from typing import List, Tuple
import logging

# Get the system logger
logger = logging.getLogger("system_logger")

class RomM2SteamDeckDatabase:
    def __init__(self, db_name: str):
        """
        Initializes the connection to the SQLite database.

        The connection is shared across Flask request threads and background
        download threads, so every operation is serialized with a lock.
        """
        self.db_name = db_name
        self.connection = sqlite3.connect(self.db_name, check_same_thread=False)
        self._lock = threading.Lock()

    def execute_query(self, query: str, params: Tuple = ()) -> None:
        """
        Executes a SQL query without return value (INSERT, UPDATE, DELETE).
        Raises sqlite3.Error on failure so callers can react.
        """
        with self._lock:
            try:
                cursor = self.connection.cursor()
                cursor.execute(query, params)
                self.connection.commit()
            except sqlite3.Error as e:
                logger.error(f"SQLite Error: (0) {e} -- query: {query}")
                self.connection.rollback()
                raise

    def update(self, table: str, updates: dict, condition: str, condition_values: Tuple) -> None:
        """
        Executes an UPDATE in the database.
        """
        set_clause = ', '.join([f"{key} = ?" for key in updates.keys()])
        query = f"UPDATE {table} SET {set_clause} WHERE {condition}"
        values = tuple(updates.values()) + condition_values
        self.execute_query(query, values)

    def column_exists(self, table: str, column: str) -> bool:
        """
        Returns True if the given column exists on the table.
        """
        with self._lock:
            cursor = self.connection.cursor()
            cursor.execute(f"PRAGMA table_info({table})")
            return any(row[1] == column for row in cursor.fetchall())

    def select_as_dict(self, table: str, columns: List[str] = ['*'], condition: str = '', condition_values: Tuple = (), order_by: str = '') -> List[dict]:
        """
        Executes a SELECT in the database and returns the results as a list of dictionaries.
        """
        cols = ', '.join(columns)
        query = f"SELECT {cols} FROM {table}"
        if condition:
            query += f" WHERE {condition}"
        if order_by:
            query += f" ORDER BY {order_by}"

        with self._lock:
            try:
                cursor = self.connection.cursor()
                cursor.execute(query, condition_values)
                rows = cursor.fetchall()
                column_names = [desc[0] for desc in cursor.description]  # Gets the column names
                return [dict(zip(column_names, row)) for row in rows]  # Creates dicts
            except sqlite3.Error as e:
                logger.error(f"SQLite Error: (2) {e}")
                return []
