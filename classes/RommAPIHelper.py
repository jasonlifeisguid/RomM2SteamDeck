import requests
from base64 import b64encode
import os
import urllib.parse
import logging

# Get the system logger
logger = logging.getLogger("system_logger")

class RommAPIHelper:
    # Default timeout for API requests (seconds)
    REQUEST_TIMEOUT = 30
    
    def __init__(self, api_base_url):
        self.api_base_url = api_base_url        
    
    def login(self, username, password):
        url = self.api_base_url + '/token'
        
        auth_string = f"{username}:{password}"
        self.auth_encoded = b64encode(auth_string.encode()).decode()              

    # Heartbeat
    def getRommHeartbeat(self):
        # Prepare URL
        url = self.api_base_url + '/heartbeat'

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {self.auth_encoded}"
        }

        # Do HTTP GET Request
        response = requests.get(url, headers=headers, timeout=self.REQUEST_TIMEOUT)

        if response.status_code == 200:
            return response.json()
        else:
            logger.error(f"Heartbeat error: {response.status_code} {response.text}")
            return None
    
    
    def getCollections(self):

        # Prepare URL
        url = self.api_base_url + '/collections/'

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {self.auth_encoded}"
        }              

        # Do HTTP GET Request
        response = requests.get(url, headers=headers, timeout=self.REQUEST_TIMEOUT)

        if response.status_code == 200:
            return response.json()
        else:
            logger.error(f"Get collections error: {response.status_code} {response.text}")
            return None

    def getCollectionByID(self, collectionID):

        # Prepare URL
        url = self.api_base_url + '/collections/' + str(collectionID)

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {self.auth_encoded}"
        }              

        # Do HTTP GET Request
        response = requests.get(url, headers=headers, timeout=self.REQUEST_TIMEOUT)

        if response.status_code == 200:
            return response.json()
        else:
            logger.error(f"Get collection {collectionID} error: {response.status_code} {response.text}")
            return None

    
    def getPlatforms(self):
        # Prepare URL
        url = self.api_base_url + '/platforms/'

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {self.auth_encoded}"
        }  

        # Do HTTP GET Request
        response = requests.get(url, headers=headers, timeout=self.REQUEST_TIMEOUT)

        if response.status_code == 200:
            return response.json()
        else:
            logger.error(f"Get platforms error: {response.status_code} {response.text}")
            return []
    
    def getRomByID(self, romID):
        # Prepare URL
        url = self.api_base_url + '/roms/' + str(romID)

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {self.auth_encoded}"
        }  

        # Do HTTP GET Request
        response = requests.get(url, headers=headers, timeout=self.REQUEST_TIMEOUT)

        if response.status_code == 200:
            return response.json()
        else:
            logger.error(f"Get ROM {romID} error: {response.status_code} {response.text}")
            return None

    def getRomsByPlatform(self, platform_id, limit=500):
        """Fetch all ROMs for a specific platform."""
        # RomM API uses platform_ids (plural) for filtering
        url = f"{self.api_base_url}/roms?platform_ids={platform_id}&order_by=name&order_dir=asc&limit={limit}"

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Authorization": f"Basic {self.auth_encoded}"
        }  

        # Do HTTP GET Request
        response = requests.get(url, headers=headers, timeout=self.REQUEST_TIMEOUT)

        if response.status_code == 200:
            data = response.json()
            # Handle paginated response - RomM returns { items: [...], total: ... }
            if isinstance(data, dict):
                return data.get('items', [])
            elif isinstance(data, list):
                return data
            return []
        else:
            logger.error(f"Get ROMs for platform {platform_id} error: {response.status_code} {response.text}")
            return []         

    def downloadRom(self, romID, romFilename, download_path, progress_callback=None):
        # Prepare URL
        url = self.api_base_url + '/roms/' + str(romID) + '/content/' + str(romFilename)

        # Prepare Headers
        headers = {
            "accept": "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
            "Authorization": f"Basic {self.auth_encoded}"
        }  

        # Do HTTP GET Request with streaming
        response = requests.get(url, headers=headers, stream=True)

        if response.status_code == 200:
            # Get total file size
            total_size = int(response.headers.get('content-length', 0))
            
            # Get Filename from HTTP-Request Response
            content_disposition = response.headers.get("content-disposition")
            if content_disposition and "filename=" in content_disposition:
                filename = content_disposition.split("filename=")[1].strip('"')
                filename = urllib.parse.unquote(filename)  # Decodes %20 to spaces
            else:
                filename = romFilename

            # make sure the Download Folder exists | If not, create it
            os.makedirs(download_path, exist_ok=True)

            # build file-path
            file_path = os.path.join(download_path, filename)

            # Check if File exists
            if os.path.exists(file_path):
                logger.info(f"File already exists: {file_path} - Download skipped.")
                return {"skipped": True, "path": file_path, "filename": filename}
            else:
                # Download File in Chunks and save it
                downloaded = 0
                chunk_size = 1024 * 1024  # 1MB chunks for better progress updates
                
                with open(file_path, "wb") as file:
                    for chunk in response.iter_content(chunk_size=chunk_size):
                        if chunk:
                            file.write(chunk)
                            downloaded += len(chunk)
                            
                            # Call progress callback if provided
                            if progress_callback and total_size > 0:
                                progress = int((downloaded / total_size) * 100)
                                progress_callback(downloaded, total_size, progress)
                
                return {"skipped": False, "path": file_path, "filename": filename}
        else:
            # Something went wrong
            logger.error(f"Download error for ROM {romID}: {response.status_code} {response.text}")
            raise Exception(f"Download failed: {response.status_code} {response.text}") 
